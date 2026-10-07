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
  MESSAGE_STATUSES,
  newSessionMessage,
  newSessionRecord,
  patchSessionMessage,
  patchSessionRecord,
  SESSION_ROLES,
  SESSION_STATUSES,
} from "@foundry/agents/session";
import { hasErrorCode, writeFileAtomic } from "@foundry/lib/atomic-file";
import { FileLockTimeoutError, withFileLock } from "@foundry/lib/file-lock";
import { KeyedQueue } from "@foundry/lib/keyed-queue";
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
 * Mutations of one file take turns: queued within this process across store
 * instances, and across processes under `<sessionId>.json.lock`, which holds
 * the writer's pid. A lock whose process has exited is replaced, so a crash
 * cannot stall a session.
 *
 * A file that exists but does not read as a session is never overwritten:
 * reads skip it (and say so through `warn`), and mutations, `createSession`
 * included, throw until someone repairs or removes it.
 *
 * `createSession` with the id of a session that exists returns that session
 * unchanged, like `InMemorySessionStore`: two hosts that both saw it missing
 * must not reset each other's history.
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
      role: z.enum(SESSION_ROLES),
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
/** How long a mutation waits for another live process's write. */
const LOCK_WAIT_MS = 10_000;

/** Mutations queued per file path, shared by every store in this process. */
const queue = new KeyedQueue();

/** A session's file as it is now. */
type Read =
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly reason: string }
  | { readonly kind: "session"; readonly file: SessionFile };

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
      const read = this.#parse(id, contents);
      if (read.kind === "session") {
        records.push(read.file.session);
      } else if (read.kind === "unreadable") {
        this.#skipped(id, read.reason);
      }
    }
    return records.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Creates the session, or returns the one already filed under `input.id`. */
  async createSession(input: CreateSessionInput = {}): Promise<SessionRecord> {
    const session = newSessionRecord(input);
    const created = await this.#change(session.id, (file) =>
      file
        ? { result: file.session }
        : { file: { messages: [], session }, result: session }
    );
    return created ?? session;
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    return (await this.#readable(id))?.session ?? null;
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
    // Not where it was last seen, or written by another process: look in
    // every readable session. An unreadable one cannot hold it.
    for (const sessionId of this.#ids()) {
      if (sessionId === owner) {
        continue;
      }
      const read = await this.#read(sessionId);
      if (
        read.kind !== "session" ||
        !read.file.messages.some((message) => message.id === id)
      ) {
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
    return [...((await this.#readable(sessionId))?.messages ?? [])];
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

  #skipped(id: string, reason: string): void {
    this.#warn(`[sessions] skipped ${id}${SUFFIX}: ${reason}`);
  }

  /** The session for a read: an unreadable file reads as absent, with a warning. */
  async #readable(id: string): Promise<SessionFile | undefined> {
    const read = await this.#read(id);
    if (read.kind === "unreadable") {
      this.#skipped(id, read.reason);
    }
    return read.kind === "session" ? read.file : undefined;
  }

  async #read(id: string): Promise<Read> {
    let contents: string;
    try {
      contents = await readFile(this.#path(id), "utf8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return { kind: "missing" };
      }
      throw error;
    }
    return this.#parse(id, contents);
  }

  #parse(id: string, contents: string): Read {
    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      return { kind: "unreadable", reason: "not JSON" };
    }
    const parsed = sessionFileSchema.safeParse(value);
    if (!parsed.success) {
      return { kind: "unreadable", reason: "not a session file" };
    }
    if (parsed.data.session.id !== id) {
      return {
        kind: "unreadable",
        reason: `holds session ${parsed.data.session.id}`,
      };
    }
    for (const message of parsed.data.messages) {
      this.#owners.set(message.id, id);
    }
    return { file: parsed.data, kind: "session" };
  }

  /**
   * Read the session's file afresh, apply `change`, and write what it returns,
   * taking turns with every other change to that file (see the module
   * comment). Resolves to the change's result, or `undefined` when it
   * declined. Throws, writing nothing, when the file exists but is unreadable.
   */
  #change<T>(id: string, change: Change<T>): Promise<T | undefined> {
    const path = this.#path(id);
    return queue.run(path, () =>
      this.#locked(id, path, async () => {
        const read = await this.#read(id);
        if (read.kind === "unreadable") {
          throw new Error(
            `[json-session-store] ${path} is not a readable session (${read.reason}); repair or remove it`
          );
        }
        const outcome = change(read.kind === "session" ? read.file : undefined);
        if (outcome?.file) {
          await writeFileAtomic(path, JSON.stringify(outcome.file, null, 2));
          for (const message of outcome.file.messages) {
            this.#owners.set(message.id, id);
          }
        }
        return outcome?.result;
      })
    );
  }

  async #locked<T>(
    id: string,
    path: string,
    operation: () => Promise<T>
  ): Promise<T> {
    try {
      return await withFileLock(`${path}.lock`, operation, {
        breakStale: true,
        waitMs: LOCK_WAIT_MS,
      });
    } catch (error) {
      if (!(error instanceof FileLockTimeoutError)) {
        throw error;
      }
      const holder =
        error.holder === undefined ? "" : ` by process ${String(error.holder)}`;
      throw new Error(
        `[json-session-store] session ${id} is locked${holder} (${error.path})`,
        { cause: error }
      );
    }
  }
}
