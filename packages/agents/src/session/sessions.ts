import { generateId } from "ai";

import type { SessionStore } from "../store";
import { InMemorySessionStore } from "../store/memory";
import type {
  MessageMetadata,
  MessageStatus,
  SessionMessage,
  SessionPart,
  SessionRecord,
  SessionRole,
  SessionStatus,
} from "./types";

export interface CreateSessionInput {
  /**
   * Adopt a specific id (e.g. to resume a known session). Generated if absent.
   * When a session with this id already exists, `createSession` returns it
   * unchanged, history included, and ignores the other fields: two callers
   * that both saw it missing must not reset each other.
   */
  id?: string;
  /** The invoking parent message id. */
  parentMessageId?: string;
  /** Parent session id — writes the sub-agent linkage. */
  parentSessionId?: string;
  /** Frozen recursion depth for this session (parent depth + 1). */
  recursionDepth?: number;
  title?: string;
}

export interface UpdateSessionInput {
  status?: SessionStatus;
  title?: string | null;
}

export interface CreateMessageInput {
  metadata?: MessageMetadata;
  parts: SessionPart[];
  role: SessionRole;
  sessionId: string;
  status?: MessageStatus;
  summarized?: boolean;
}

export interface UpdateMessageInput {
  metadata?: MessageMetadata;
  parts?: SessionPart[];
  status?: MessageStatus;
  summarized?: boolean;
}

export interface SummarizeInput {
  /** Marker; messages before this one are folded (exclusive). */
  messageId: string;
  sessionId: string;
  summary: {
    parts: SessionPart[];
    metadata?: MessageMetadata;
    status?: MessageStatus;
  };
}

export interface SummarizeResult {
  summarizedIds: string[];
  summary: SessionMessage;
}

export interface SessionsOptions {
  /** Persistence. Defaults to an in-memory store. */
  readonly store?: SessionStore;
}

/**
 * Sessions and their messages: the one place that writes a session store.
 *
 * Holds every rule — a message needs its session, a session is filed once,
 * a summary folds the history before it — and builds each change as one
 * {@link SessionStore.commit}. Reads project the store. Mutations serialize
 * per instance; when the store offers a `transaction`, each runs in one, so
 * no write from another `Sessions` over the store lands between its reads
 * and its commit.
 */
export class Sessions {
  readonly #store: SessionStore;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: SessionsOptions = {}) {
    this.#store = options.store ?? new InMemorySessionStore();
  }

  getSession(id: string): Promise<SessionRecord | null> {
    return this.#store.getSession(id);
  }

  /** Messages for a session, in insertion order. */
  listMessages(sessionId: string): Promise<SessionMessage[]> {
    return this.#store.listMessages(sessionId);
  }

  /** The latest summary (if any) prepended to the non-summarized, non-summary messages. */
  async activeMessages(sessionId: string): Promise<SessionMessage[]> {
    return activeView(await this.#store.listMessages(sessionId));
  }

  /** Creates a session; one already filed under `input.id` is returned unchanged, history kept. */
  createSession(input: CreateSessionInput = {}): Promise<SessionRecord> {
    const record = newSessionRecord(input);
    return this.#mutation(async (store) => {
      const existing = await store.getSession(record.id);
      if (existing) {
        return existing;
      }
      await store.commit({ putSessions: [record] });
      return record;
    });
  }

  updateSession(
    id: string,
    patch: UpdateSessionInput
  ): Promise<SessionRecord | null> {
    return this.#mutation(async (store) => {
      const current = await store.getSession(id);
      if (!current) {
        return null;
      }
      const next = patchSessionRecord(current, patch);
      await store.commit({ putSessions: [next] });
      return next;
    });
  }

  /** Appends a message to its session; rejects when the session is unknown. */
  appendMessage(input: CreateMessageInput): Promise<SessionMessage> {
    return this.#mutation(async (store) => {
      if (!(await store.getSession(input.sessionId))) {
        throw new Error(`[sessions] unknown session: ${input.sessionId}`);
      }
      const message = newSessionMessage(input);
      await store.commit({ putMessages: [message] });
      return message;
    });
  }

  updateMessage(
    id: string,
    patch: UpdateMessageInput
  ): Promise<SessionMessage | null> {
    return this.#mutation(async (store) => {
      const current = await store.getMessage(id);
      if (!current) {
        return null;
      }
      const next = patchSessionMessage(current, patch);
      await store.commit({ putMessages: [next] });
      return next;
    });
  }

  /**
   * Fold the messages before `messageId` under a new summary, in one write:
   * the summary and every `summarized` flip it stands for land together or
   * not at all. A summary only means "these messages are folded" if every
   * message it covers is flipped; a partial write would read back as a
   * corrupt history — duplicated or dropped context on the next compaction.
   * `null` when nothing new precedes the marker.
   */
  summarize(input: SummarizeInput): Promise<SummarizeResult | null> {
    return this.#mutation(async (store) => {
      const messages = await store.listMessages(input.sessionId);
      const fold = foldSet(messages, input.messageId);
      if (fold.length === 0) {
        return null;
      }
      const summary = newSessionMessage({
        metadata: input.summary.metadata,
        parts: input.summary.parts,
        role: "summary",
        sessionId: input.sessionId,
        status: input.summary.status,
        summarized: false,
      });
      const folded = fold.map((m) =>
        patchSessionMessage(m, { summarized: true })
      );
      await store.commit({ putMessages: [...folded, summary] });
      return { summarizedIds: fold.map((m) => m.id), summary };
    });
  }

  #mutation<T>(work: (store: SessionStore) => Promise<T>): Promise<T> {
    return this.#serialized(() => this.#transaction(work));
  }

  #transaction<T>(work: (store: SessionStore) => Promise<T>): Promise<T> {
    const store = this.#store;
    return store.transaction === undefined
      ? work(store)
      : store.transaction(work);
  }

  #serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work, work);
    this.#tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

/** Real messages before `messageId` (exclusive): non-summarized, non-summary. */
export function messagesToSummarize(
  messages: SessionMessage[],
  messageId: string
): SessionMessage[] {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) {
    return [];
  }
  return messages
    .slice(0, idx)
    .filter((m) => !m.summarized && m.role !== "summary");
}

function latestActiveSummary(
  messages: SessionMessage[]
): SessionMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role === "summary" && !m.summarized) {
      return m;
    }
  }
  return undefined;
}

function activeView(messages: SessionMessage[]): SessionMessage[] {
  const summary = latestActiveSummary(messages);
  const rest = messages.filter((m) => !m.summarized && m.role !== "summary");
  return summary ? [summary, ...rest] : rest;
}

/**
 * The slice one compaction folds: the latest active summary (if any) followed by
 * the real, not-yet-summarized messages before `messageId`. Folding the prior
 * summary back in makes each new summary subsume the last, so a repeat compaction
 * never drops earlier context. Empty when no new real message precedes the marker.
 */
export function foldSet(
  messages: SessionMessage[],
  messageId: string
): SessionMessage[] {
  const pending = messagesToSummarize(messages, messageId);
  if (pending.length === 0) {
    return [];
  }
  const prior = latestActiveSummary(messages);
  return prior ? [prior, ...pending] : pending;
}

/**
 * The record `createSession` files for `input`. Absent optionals are left out
 * rather than set to `undefined`, so a store that serializes the record reads
 * back exactly what it wrote.
 */
export function newSessionRecord(
  input: CreateSessionInput = {},
  now: number = Date.now()
): SessionRecord {
  return {
    createdAt: now,
    id: input.id ?? generateId(),
    parentMessageId: input.parentMessageId ?? null,
    parentSessionId: input.parentSessionId ?? null,
    ...(input.recursionDepth === undefined
      ? {}
      : { recursionDepth: input.recursionDepth }),
    status: "active",
    title: input.title ?? null,
    updatedAt: now,
  };
}

/** `current` with the fields `patch` sets, stamped `updatedAt: now`. */
export function patchSessionRecord(
  current: SessionRecord,
  patch: UpdateSessionInput,
  now: number = Date.now()
): SessionRecord {
  return {
    ...current,
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.status === undefined ? {} : { status: patch.status }),
    updatedAt: now,
  };
}

/** The message `appendMessage` files for `input`, with a fresh id; absent optionals left out. */
export function newSessionMessage(
  input: CreateMessageInput,
  now: number = Date.now()
): SessionMessage {
  return {
    createdAt: now,
    id: generateId(),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    parts: input.parts,
    role: input.role,
    sessionId: input.sessionId,
    status: input.status ?? "complete",
    ...(input.summarized === undefined ? {} : { summarized: input.summarized }),
    updatedAt: now,
  };
}

/** `current` with the fields `patch` sets, stamped `updatedAt: now`. */
export function patchSessionMessage(
  current: SessionMessage,
  patch: UpdateMessageInput,
  now: number = Date.now()
): SessionMessage {
  return {
    ...current,
    ...(patch.parts === undefined ? {} : { parts: patch.parts }),
    ...(patch.status === undefined ? {} : { status: patch.status }),
    ...(patch.metadata === undefined ? {} : { metadata: patch.metadata }),
    ...(patch.summarized === undefined ? {} : { summarized: patch.summarized }),
    updatedAt: now,
  };
}
