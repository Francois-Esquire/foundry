import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  CreateMessageInput,
  CreateSessionInput,
  MessageMetadata,
  SessionMessage,
  SessionPart,
  SessionRecord,
  SummarizeInput,
  SummarizeResult,
  UpdateMessageInput,
  UpdateSessionInput,
} from "@foundry/agents/session";
import {
  AbstractSessionStore,
  foldSet,
  newSessionMessage,
  newSessionRecord,
  patchSessionMessage,
  patchSessionRecord,
} from "@foundry/agents/session";
import { hasErrorCode, writeFileAtomic } from "@foundry/lib/atomic-file";
import { z } from "zod";
import { isRecord } from "~/lib/state/json";

/**
 * Durable sessions as one JSON file each: `<dir>/<sessionId>.json` holding
 * the record and every message.
 *
 * The files are the truth, not this object: every read and every mutation
 * reads the session's file again, so a session another process (the
 * dashboard, a launchd `roll`) wrote is seen, and appending here does not
 * overwrite what it appended. Each mutation is one read-change-write of one
 * file through a temp-and-rename, which is what makes `summarize` atomic.
 * Mutations of one file are queued in this process, across store instances.
 * Two processes changing the same session in the same instant can still lose
 * one change: there is no cross-process lock, because a lock a crashed process
 * left behind would stall every session.
 *
 * Deliberately not a database. The session id is the file name, so a
 * scheduled workflow that names its session finds it again next process.
 */

interface SessionFile {
  readonly messages: SessionMessage[];
  readonly session: SessionRecord;
}

export interface JsonSessionStoreOptions {
  /** Told about each file skipped because it does not read as a session. */
  readonly warn?: (line: string) => void;
}

const SESSION_STATUSES = ["active", "archived", "error"] as const;
const MESSAGE_STATUSES = ["streaming", "complete", "error"] as const;
const ROLES = ["user", "assistant", "system", "tool", "summary"] as const;

/** The shape the store relies on; unknown keys are kept, so a rewrite never drops them. */
const sessionFileSchema: z.ZodType<SessionFile> = z.object({
  messages: z.array(
    z.looseObject({
      createdAt: z.number(),
      id: z.string().min(1),
      metadata: z.custom<MessageMetadata>(isRecord).optional(),
      parts: z.array(
        z.custom<SessionPart>(
          (part) => isRecord(part) && typeof part.type === "string"
        )
      ),
      role: z.enum(ROLES),
      sessionId: z.string(),
      status: z.enum(MESSAGE_STATUSES),
      summarized: z.boolean().optional(),
      updatedAt: z.number(),
    })
  ),
  session: z.looseObject({
    createdAt: z.number(),
    id: z.string().min(1),
    parentMessageId: z.string().nullable().optional(),
    parentSessionId: z.string().nullable().optional(),
    recursionDepth: z.number().optional(),
    status: z.enum(SESSION_STATUSES),
    title: z.string().nullable(),
    updatedAt: z.number(),
  }),
});

const SUFFIX = ".json";

/** Mutations queued per file path, shared by every store in this process. */
const queues = new Map<string, Promise<void>>();

type Change<T> = (file: SessionFile | undefined) =>
  | {
      /** The file to write; absent when nothing changed. */
      readonly file?: SessionFile;
      readonly result: T;
    }
  | undefined;

export class JsonSessionStore extends AbstractSessionStore {
  readonly #dir: string;
  readonly #warn: (line: string) => void;
  /** Message id → its session, as last seen here. A hint: always checked against the file. */
  readonly #owners = new Map<string, string>();

  constructor(dir: string, options: JsonSessionStoreOptions = {}) {
    super();
    this.#dir = resolve(dir);
    this.#warn = options.warn ?? (() => undefined);
    mkdirSync(this.#dir, { recursive: true });
  }

  /** Every readable session on disk, newest first. */
  sessions(): readonly SessionRecord[] {
    const records: SessionRecord[] = [];
    for (const id of this.#ids()) {
      let contents: string;
      try {
        contents = readFileSync(this.#path(id), "utf8");
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) {
          continue;
        }
        throw error;
      }
      const file = this.#parse(id, contents);
      if (file) {
        records.push(file.session);
      }
    }
    return records.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async createSession(input: CreateSessionInput = {}): Promise<SessionRecord> {
    const session = newSessionRecord(input);
    await this.#change(session.id, () => ({
      file: { messages: [], session },
      result: session,
    }));
    return session;
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    return (await this.#read(id))?.session ?? null;
  }

  async updateSession(
    id: string,
    patch: UpdateSessionInput
  ): Promise<SessionRecord | null> {
    const updated = await this.#change(id, (file) => {
      if (!file) {
        return;
      }
      const session = patchSessionRecord(file.session, patch);
      return { file: { messages: file.messages, session }, result: session };
    });
    return updated ?? null;
  }

  async appendMessage(input: CreateMessageInput): Promise<SessionMessage> {
    const appended = await this.#change(input.sessionId, (file) => {
      if (!file) {
        return;
      }
      const message = newSessionMessage(input);
      return {
        file: {
          messages: [...file.messages, message],
          session: { ...file.session, updatedAt: message.createdAt },
        },
        result: message,
      };
    });
    if (!appended) {
      throw new Error(
        `[json-session-store] unknown session: ${input.sessionId}`
      );
    }
    return appended;
  }

  async updateMessage(
    id: string,
    patch: UpdateMessageInput
  ): Promise<SessionMessage | null> {
    const update: Change<SessionMessage> = (file) => {
      const current = file?.messages.find((message) => message.id === id);
      if (!(file && current)) {
        return;
      }
      const next = patchSessionMessage(current, patch);
      const messages = file.messages.map((message) =>
        message === current ? next : message
      );
      return { file: { messages, session: file.session }, result: next };
    };
    const owner = this.#owners.get(id);
    if (owner !== undefined) {
      const updated = await this.#change(owner, update);
      if (updated) {
        return updated;
      }
    }
    // Not where it was last seen, or written by another process: look everywhere.
    for (const sessionId of this.#ids()) {
      if (sessionId === owner) {
        continue;
      }
      const updated = await this.#change(sessionId, update);
      if (updated) {
        return updated;
      }
    }
    return null;
  }

  async listMessages(sessionId: string): Promise<SessionMessage[]> {
    return [...((await this.#read(sessionId))?.messages ?? [])];
  }

  /** The base implementation is a loop of writes; this is one. */
  override async summarize(
    input: SummarizeInput
  ): Promise<SummarizeResult | null> {
    const result = await this.#change(input.sessionId, (file) => {
      if (!file) {
        return;
      }
      const fold = new Set(
        foldSet(file.messages, input.messageId).map((m) => m.id)
      );
      if (fold.size === 0) {
        return;
      }
      const summary = newSessionMessage({
        metadata: input.summary.metadata,
        parts: input.summary.parts,
        role: "summary",
        sessionId: input.sessionId,
        status: input.summary.status,
        summarized: false,
      });
      const messages = file.messages.map((message) =>
        fold.has(message.id)
          ? patchSessionMessage(message, { summarized: true })
          : message
      );
      return {
        file: {
          messages: [...messages, summary],
          session: { ...file.session, updatedAt: summary.createdAt },
        },
        result: { summarizedIds: [...fold], summary },
      };
    });
    return result ?? null;
  }

  #path(id: string): string {
    return join(this.#dir, `${id}${SUFFIX}`);
  }

  #ids(): string[] {
    return readdirSync(this.#dir)
      .filter((entry) => entry.endsWith(SUFFIX))
      .map((entry) => entry.slice(0, -SUFFIX.length));
  }

  /** The session's file as it is now; `undefined` when missing or unreadable. */
  async #read(id: string): Promise<SessionFile | undefined> {
    let contents: string;
    try {
      contents = await readFile(this.#path(id), "utf8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    return this.#parse(id, contents);
  }

  #parse(id: string, contents: string): SessionFile | undefined {
    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      this.#warn(`[sessions] skipped ${id}${SUFFIX}: not JSON`);
      return;
    }
    const parsed = sessionFileSchema.safeParse(value);
    if (!parsed.success) {
      this.#warn(`[sessions] skipped ${id}${SUFFIX}: not a session file`);
      return;
    }
    if (parsed.data.session.id !== id) {
      this.#warn(
        `[sessions] skipped ${id}${SUFFIX}: holds session ${parsed.data.session.id}`
      );
      return;
    }
    for (const message of parsed.data.messages) {
      this.#owners.set(message.id, id);
    }
    return parsed.data;
  }

  /**
   * Read the session's file afresh, apply `change`, and write what it returns,
   * queued behind every other change to that file in this process. Resolves to
   * the change's result, or `undefined` when it declined.
   */
  async #change<T>(id: string, change: Change<T>): Promise<T | undefined> {
    const path = this.#path(id);
    const previous = queues.get(path) ?? Promise.resolve();
    const { promise: pending, resolve: done } = Promise.withResolvers<void>();
    queues.set(path, pending);
    try {
      await previous;
      const outcome = change(await this.#read(id));
      if (outcome?.file) {
        await writeFileAtomic(path, JSON.stringify(outcome.file, null, 2));
        for (const message of outcome.file.messages) {
          this.#owners.set(message.id, id);
        }
      }
      return outcome?.result;
    } finally {
      done();
      if (queues.get(path) === pending) {
        queues.delete(path);
      }
    }
  }
}
