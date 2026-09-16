import { generateId } from "ai";

import type {
  MessageMetadata,
  MessageStatus,
  SessionMessage,
  SessionPart,
  SessionRecord,
  SessionRole,
  SessionStatus,
} from "./types";

/**
 * The persistence seam. A session is built on a `SessionStore` and a model
 * resolver — and never names a concrete database. Swap this for a
 * drizzle/sqlite/remote implementation to back a session with any store; the
 * default {@link InMemorySessionStore} keeps everything in process so a
 * session works with zero configuration.
 *
 * All methods are async so a real (async) backing store is a legal drop-in.
 */
export interface SessionStore {
  appendMessage(input: CreateMessageInput): Promise<SessionMessage>;
  createSession(input?: CreateSessionInput): Promise<SessionRecord>;
  getSession(id: string): Promise<SessionRecord | null>;
  /** Messages for a session, in insertion order. */
  listMessages(sessionId: string): Promise<SessionMessage[]>;
  updateMessage(
    id: string,
    patch: UpdateMessageInput
  ): Promise<SessionMessage | null>;
  updateSession(
    id: string,
    patch: UpdateSessionInput
  ): Promise<SessionRecord | null>;
}

export interface CreateSessionInput {
  /** Adopt a specific id (e.g. to resume a known session). Generated if absent. */
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

export interface SummarizableStore extends SessionStore {
  /** The latest summary (if any) prepended to the non-summarized, non-summary messages. */
  activeMessages(sessionId: string): Promise<SessionMessage[]>;
  /**
   * Fold the messages before `messageId` under a new summary. Implementations
   * MUST apply the summary append and the per-message `summarized` flips
   * **atomically** (a single transaction). The two steps are a unit: a summary
   * row only means "these messages are folded" if every message it covers is
   * actually flipped. A mid-failure that commits the summary but only some of
   * the flips (or vice versa) leaves a summary covering a partially-flipped set,
   * which {@link activeMessages} then reads as a corrupt history — duplicated or
   * dropped context on the next compaction. Backing stores must not expose that
   * intermediate state.
   */
  summarize(input: SummarizeInput): Promise<SummarizeResult | null>;
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
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "summary" && !m.summarized) {
      return m;
    }
  }
  return undefined;
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
 * Base for any session store: subclasses supply the raw CRUD; this provides the
 * shared summarize + active-view behavior so every store (in-memory, db DAO)
 * folds history identically.
 */
export abstract class AbstractSessionStore implements SummarizableStore {
  abstract createSession(input?: CreateSessionInput): Promise<SessionRecord>;
  abstract getSession(id: string): Promise<SessionRecord | null>;
  abstract updateSession(
    id: string,
    patch: UpdateSessionInput
  ): Promise<SessionRecord | null>;
  abstract appendMessage(input: CreateMessageInput): Promise<SessionMessage>;
  abstract updateMessage(
    id: string,
    patch: UpdateMessageInput
  ): Promise<SessionMessage | null>;
  abstract listMessages(sessionId: string): Promise<SessionMessage[]>;

  /**
   * Reference (non-atomic) implementation: appends the summary, then flips each
   * folded message's `summarized` flag in a loop. Safe here only because the
   * in-memory store can't fail mid-loop. Real backing stores MUST override or
   * wrap this so the append + flips commit as one transaction — see the
   * atomicity contract on {@link SummarizableStore.summarize}; a partial commit
   * corrupts the active-message view and the next compaction.
   */
  async summarize(input: SummarizeInput): Promise<SummarizeResult | null> {
    const messages = await this.listMessages(input.sessionId);
    const fold = foldSet(messages, input.messageId);
    if (fold.length === 0) {
      return null;
    }

    const summary = await this.appendMessage({
      metadata: input.summary.metadata,
      parts: input.summary.parts,
      role: "summary",
      sessionId: input.sessionId,
      status: input.summary.status,
      summarized: false,
    });

    const summarizedIds: string[] = [];
    for (const m of fold) {
      await this.updateMessage(m.id, { summarized: true });
      summarizedIds.push(m.id);
    }
    return { summarizedIds, summary };
  }

  async activeMessages(sessionId: string): Promise<SessionMessage[]> {
    const messages = await this.listMessages(sessionId);
    const summary = latestActiveSummary(messages);
    const rest = messages.filter((m) => !m.summarized && m.role !== "summary");
    return summary ? [summary, ...rest] : rest;
  }
}

/**
 * Default, dependency-free store. Holds sessions and their messages in plain
 * Maps — the zero-config backing for a session, and the reference
 * implementation any persistent store must match behaviorally.
 */
export class InMemorySessionStore extends AbstractSessionStore {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #messages = new Map<string, SessionMessage[]>();

  createSession(input: CreateSessionInput = {}): Promise<SessionRecord> {
    const now = Date.now();
    const record: SessionRecord = {
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
    this.#sessions.set(record.id, record);
    this.#messages.set(record.id, []);
    return Promise.resolve(record);
  }

  getSession(id: string): Promise<SessionRecord | null> {
    return Promise.resolve(this.#sessions.get(id) ?? null);
  }

  updateSession(
    id: string,
    patch: UpdateSessionInput
  ): Promise<SessionRecord | null> {
    const current = this.#sessions.get(id);
    if (!current) {
      return Promise.resolve(null);
    }
    const next: SessionRecord = {
      ...current,
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      updatedAt: Date.now(),
    };
    this.#sessions.set(id, next);
    return Promise.resolve(next);
  }

  appendMessage(input: CreateMessageInput): Promise<SessionMessage> {
    const bucket = this.#messages.get(input.sessionId);
    if (!bucket) {
      return Promise.reject(
        new Error(`[session-store] unknown session: ${input.sessionId}`)
      );
    }
    const now = Date.now();
    const message: SessionMessage = {
      id: generateId(),
      metadata: input.metadata,
      parts: input.parts,
      role: input.role,
      sessionId: input.sessionId,
      status: input.status ?? "complete",
      ...(input.summarized === undefined
        ? {}
        : { summarized: input.summarized }),
      createdAt: now,
      updatedAt: now,
    };
    bucket.push(message);
    return Promise.resolve(message);
  }

  updateMessage(
    id: string,
    patch: UpdateMessageInput
  ): Promise<SessionMessage | null> {
    for (const bucket of this.#messages.values()) {
      const idx = bucket.findIndex((m) => m.id === id);
      if (idx === -1) {
        continue;
      }
      const current = bucket[idx];
      if (!current) {
        continue;
      }
      const next: SessionMessage = {
        ...current,
        ...(patch.parts === undefined ? {} : { parts: patch.parts }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.metadata === undefined ? {} : { metadata: patch.metadata }),
        ...(patch.summarized === undefined
          ? {}
          : { summarized: patch.summarized }),
        updatedAt: Date.now(),
      };
      bucket[idx] = next;
      return Promise.resolve(next);
    }
    return Promise.resolve(null);
  }

  listMessages(sessionId: string): Promise<SessionMessage[]> {
    return Promise.resolve([...(this.#messages.get(sessionId) ?? [])]);
  }
}
