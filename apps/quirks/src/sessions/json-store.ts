import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CreateMessageInput,
  CreateSessionInput,
  SessionMessage,
  SessionRecord,
  SummarizeInput,
  SummarizeResult,
  UpdateMessageInput,
  UpdateSessionInput,
} from "@foundry/agents/session";
import { AbstractSessionStore, foldSet } from "@foundry/agents/session";
import { generateId } from "ai";

/**
 * Durable sessions as one JSON file each: `<dir>/<sessionId>.json` holding
 * the record and every message. Every file is loaded at construction, so the
 * store answers reads from memory and each mutation rewrites one file through
 * a temp-and-rename, which is what makes `summarize` atomic here.
 *
 * Deliberately not a database. The session id is the file name, so a
 * scheduled workflow that names its session finds it again next process.
 */

interface SessionFile {
  readonly messages: SessionMessage[];
  readonly session: SessionRecord;
}

export class JsonSessionStore extends AbstractSessionStore {
  readonly #dir: string;
  readonly #files = new Map<string, SessionFile>();

  constructor(dir: string) {
    super();
    this.#dir = dir;
    mkdirSync(dir, { recursive: true });
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const file = JSON.parse(
        readFileSync(join(dir, entry), "utf8")
      ) as SessionFile;
      this.#files.set(file.session.id, file);
    }
  }

  /** Every session on disk, newest first. */
  sessions(): readonly SessionRecord[] {
    return [...this.#files.values()]
      .map((file) => file.session)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async createSession(input: CreateSessionInput = {}): Promise<SessionRecord> {
    const now = Date.now();
    const session: SessionRecord = {
      id: input.id ?? generateId(),
      parentMessageId: input.parentMessageId ?? null,
      parentSessionId: input.parentSessionId ?? null,
      status: "active",
      title: input.title ?? null,
      ...(input.recursionDepth === undefined
        ? {}
        : { recursionDepth: input.recursionDepth }),
      createdAt: now,
      updatedAt: now,
    };
    await this.#write({ messages: [], session });
    return session;
  }

  getSession(id: string): Promise<SessionRecord | null> {
    return Promise.resolve(this.#files.get(id)?.session ?? null);
  }

  async updateSession(
    id: string,
    patch: UpdateSessionInput
  ): Promise<SessionRecord | null> {
    const file = this.#files.get(id);
    if (!file) {
      return null;
    }
    const session: SessionRecord = {
      ...file.session,
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      updatedAt: Date.now(),
    };
    await this.#write({ messages: file.messages, session });
    return session;
  }

  async appendMessage(input: CreateMessageInput): Promise<SessionMessage> {
    const file = this.#files.get(input.sessionId);
    if (!file) {
      throw new Error(
        `[json-session-store] unknown session: ${input.sessionId}`
      );
    }
    const message = newMessage(input);
    await this.#write({
      messages: [...file.messages, message],
      session: { ...file.session, updatedAt: message.createdAt },
    });
    return message;
  }

  async updateMessage(
    id: string,
    patch: UpdateMessageInput
  ): Promise<SessionMessage | null> {
    for (const file of this.#files.values()) {
      const current = file.messages.find((message) => message.id === id);
      if (!current) {
        continue;
      }
      const next = patched(current, patch);
      const messages = file.messages.map((message) =>
        message === current ? next : message
      );
      await this.#write({ messages, session: file.session });
      return next;
    }
    return null;
  }

  listMessages(sessionId: string): Promise<SessionMessage[]> {
    return Promise.resolve([...(this.#files.get(sessionId)?.messages ?? [])]);
  }

  /** The base implementation is a loop of writes; this is one. */
  override async summarize(
    input: SummarizeInput
  ): Promise<SummarizeResult | null> {
    const file = this.#files.get(input.sessionId);
    if (!file) {
      return null;
    }
    const fold = new Set(
      foldSet(file.messages, input.messageId).map((m) => m.id)
    );
    if (fold.size === 0) {
      return null;
    }

    const summary = newMessage({
      metadata: input.summary.metadata,
      parts: input.summary.parts,
      role: "summary",
      sessionId: input.sessionId,
      status: input.summary.status,
      summarized: false,
    });
    const messages = file.messages.map((message) =>
      fold.has(message.id) ? patched(message, { summarized: true }) : message
    );
    await this.#write({
      messages: [...messages, summary],
      session: { ...file.session, updatedAt: summary.createdAt },
    });
    return { summarizedIds: [...fold], summary };
  }

  async #write(file: SessionFile): Promise<void> {
    this.#files.set(file.session.id, file);
    const path = join(this.#dir, `${file.session.id}.json`);
    const temp = `${path}.${generateId()}.tmp`;
    await writeFile(temp, JSON.stringify(file, null, 2));
    await rename(temp, path);
  }
}

function newMessage(input: CreateMessageInput): SessionMessage {
  const now = Date.now();
  return {
    id: generateId(),
    parts: input.parts,
    role: input.role,
    sessionId: input.sessionId,
    status: input.status ?? "complete",
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.summarized === undefined ? {} : { summarized: input.summarized }),
    createdAt: now,
    updatedAt: now,
  };
}

function patched(
  current: SessionMessage,
  patch: UpdateMessageInput
): SessionMessage {
  return {
    ...current,
    ...(patch.parts === undefined ? {} : { parts: patch.parts }),
    ...(patch.status === undefined ? {} : { status: patch.status }),
    ...(patch.metadata === undefined ? {} : { metadata: patch.metadata }),
    ...(patch.summarized === undefined ? {} : { summarized: patch.summarized }),
    updatedAt: Date.now(),
  };
}
