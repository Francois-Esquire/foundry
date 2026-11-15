import { generateId } from "ai";

import type { SessionChangeEvent } from "../schema";
import type { SessionStore } from "../store";
import { InMemorySessionStore } from "../store/memory";
import { metadataFault, partsFault } from "../store/message-shape";
import { keptValue } from "./serialize";
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
 * appending or folding a message touches its session, a summary folds the
 * history before it — and builds each change as one
 * {@link SessionStore.commit}, carrying the change events that say what it
 * changed (see {@link SessionChangeEvent}). A message updated in place, and
 * a session update that changes neither title nor status, carry none. Every record it writes is in its kept form
 * (see {@link keptMessage}), so every store is handed the same values. Reads project the store. Mutations serialize
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
    const record = keptSession(newSessionRecord(input));
    const created = changeEvent("session.created", record.id, record.createdAt);
    return this.#mutation(async (store) => {
      const existing = await store.getSession(record.id);
      if (existing) {
        return existing;
      }
      await store.commit({ events: [created], putSessions: [record] });
      return record;
    });
  }

  updateSession(
    id: string,
    patch: UpdateSessionInput
  ): Promise<SessionRecord | null> {
    // Read now: a caller changing `patch` afterwards changes nothing.
    const taken: UpdateSessionInput = {
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.title === undefined ? {} : { title: patch.title }),
    };
    const eventId = generateId();
    return this.#mutation(async (store) => {
      const current = await store.getSession(id);
      if (!current) {
        return null;
      }
      const next = keptSession(patchSessionRecord(current, taken));
      const changed =
        next.title !== current.title || next.status !== current.status;
      await store.commit({
        ...(changed
          ? {
              events: [
                changeEvent("session.updated", id, next.updatedAt, eventId),
              ],
            }
          : {}),
        putSessions: [next],
      });
      return next;
    });
  }

  /**
   * Appends a message to its session and stamps the session's `updatedAt`
   * with the message's `createdAt`, unless it is already later; rejects
   * when the session is unknown. The message is built in its kept form when
   * this is called, so a caller changing `input` afterwards changes nothing.
   */
  appendMessage(input: CreateMessageInput): Promise<SessionMessage> {
    let message: SessionMessage;
    try {
      message = keptMessage(newSessionMessage(input));
    } catch (error) {
      return Promise.reject(error);
    }
    const appended = messagesAppended(message);
    return this.#mutation(async (store) => {
      const session = await store.getSession(message.sessionId);
      if (!session) {
        throw new Error(`[sessions] unknown session: ${message.sessionId}`);
      }
      await store.commit({
        events: [appended],
        putMessages: [message],
        putSessions: [touched(session, message)],
      });
      return message;
    });
  }

  /** `patch` is put in its kept form when this is called, so a caller changing it afterwards changes nothing. */
  updateMessage(
    id: string,
    patch: UpdateMessageInput
  ): Promise<SessionMessage | null> {
    let taken: UpdateMessageInput;
    try {
      taken = keptPatch(id, patch);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#mutation(async (store) => {
      const current = await store.getMessage(id);
      if (!current) {
        return null;
      }
      const next = keptMessage(patchSessionMessage(current, taken), {
        metadata: taken.metadata !== undefined,
        parts: taken.parts !== undefined,
      });
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
   * The summary is appended like any message, built in its kept form when
   * this is called. `null` when nothing new precedes the marker.
   */
  summarize(input: SummarizeInput): Promise<SummarizeResult | null> {
    const { messageId, sessionId } = input;
    let summary: SessionMessage;
    try {
      summary = keptMessage(
        newSessionMessage({
          metadata: input.summary.metadata,
          parts: input.summary.parts,
          role: "summary",
          sessionId,
          status: input.summary.status,
          summarized: false,
        })
      );
    } catch (error) {
      return Promise.reject(error);
    }
    const appended = messagesAppended(summary);
    return this.#mutation(async (store) => {
      const session = await store.getSession(sessionId);
      const messages = await store.listMessages(sessionId);
      const fold = foldSet(messages, messageId);
      if (!session || fold.length === 0) {
        return null;
      }
      const folded = fold.map((m) =>
        keptMessage(patchSessionMessage(m, { summarized: true }), {
          metadata: false,
          parts: false,
        })
      );
      await store.commit({
        events: [appended],
        putMessages: [...folded, summary],
        putSessions: [touched(session, summary)],
      });
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

/**
 * A change event of `type` on `sessionId`, at the epoch milliseconds the
 * record it changed was stamped with. Built once per call, before the
 * mutation runs, so work run again keeps its id.
 */
function changeEvent(
  type: "session.created" | "session.updated",
  sessionId: string,
  at: number,
  id: string = generateId()
): SessionChangeEvent {
  return { at: new Date(at).toISOString(), id, sessionId, type };
}

/** The event saying `message` was filed in its session. */
function messagesAppended(message: SessionMessage): SessionChangeEvent {
  return {
    at: new Date(message.createdAt).toISOString(),
    id: generateId(),
    messageIds: [message.id],
    sessionId: message.sessionId,
    type: "session.messages.appended",
  };
}

/** `session` as of `message` landing in it; a clock that stepped back never moves it backwards. */
function touched(
  session: SessionRecord,
  message: SessionMessage
): SessionRecord {
  return keptSession({
    ...session,
    updatedAt: Math.max(session.updatedAt, message.createdAt),
  });
}

/**
 * A session record as every store keeps it: a field holding `undefined` is
 * left out, as JSON leaves it out.
 */
function keptSession(record: SessionRecord): SessionRecord {
  return withoutUndefined(record);
}

/**
 * A message as every store keeps it, so each store is handed, and gives
 * back, the same values: a field holding `undefined` is left out, and
 * `parts` and `metadata` are put in their JSON form (see {@link keptValue}).
 * Rejects, naming the path, a message with a value that has no JSON form
 * (a `bigint`, a cycle). It also rejects `parts` or `metadata` the caller
 * supplied whose JSON form is no message (a part that became `null`, a
 * token count that became `null` from NaN); `supplied` says which. What a
 * store already holds is not checked again, so a message filed before the
 * check, or by another writer, can still be folded or have its status set.
 */
function keptMessage(
  message: SessionMessage,
  supplied: { readonly metadata: boolean; readonly parts: boolean } = {
    metadata: true,
    parts: true,
  }
): SessionMessage {
  const { metadata, parts, ...fields } = withoutUndefined(message);
  const refuse = (why: string, cause?: unknown) =>
    new TypeError(`[sessions] cannot keep message ${message.id}: ${why}`, {
      cause,
    });
  let kept: Record<string, unknown>;
  try {
    kept = {
      ...fields,
      ...(metadata === undefined
        ? {}
        : { metadata: keptValue(metadata, "metadata") }),
      parts: keptValue(parts, "parts"),
    };
  } catch (cause) {
    throw refuse(cause instanceof Error ? cause.message : String(cause), cause);
  }
  const fault =
    (supplied.parts ? partsFault(kept.parts) : undefined) ??
    (supplied.metadata ? metadataFault(kept.metadata) : undefined);
  if (fault !== undefined) {
    throw refuse(`${fault.path} ${fault.reason}`);
  }
  return kept as unknown as SessionMessage;
}

/**
 * An update's fields, read once: its parts and metadata in their JSON form,
 * so the update holds nothing of the caller's.
 */
function keptPatch(id: string, patch: UpdateMessageInput): UpdateMessageInput {
  let kept: UpdateMessageInput;
  try {
    kept = {
      ...(patch.metadata === undefined
        ? {}
        : {
            metadata: keptValue(patch.metadata, "metadata") as MessageMetadata,
          }),
      ...(patch.parts === undefined
        ? {}
        : { parts: keptValue(patch.parts, "parts") as SessionPart[] }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.summarized === undefined
        ? {}
        : { summarized: patch.summarized }),
    };
  } catch (cause) {
    throw new TypeError(
      `[sessions] cannot keep message ${id}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
  }
  // Parts whose JSON form is no list of parts (a `toJSON` that returns
  // `undefined`, say) are refused, as `appendMessage` refuses them, rather
  // than read as parts left out.
  const fault = patch.parts === undefined ? undefined : partsFault(kept.parts);
  if (fault !== undefined) {
    throw new TypeError(
      `[sessions] cannot keep message ${id}: ${fault.path} ${fault.reason}`
    );
  }
  return kept;
}

/** `record` without the properties that hold `undefined`. */
function withoutUndefined<T extends object>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined)
  ) as T;
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

/** `current` with the fields `patch` sets, stamped `now` unless already later. */
export function patchSessionRecord(
  current: SessionRecord,
  patch: UpdateSessionInput,
  now: number = Date.now()
): SessionRecord {
  return {
    ...current,
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.status === undefined ? {} : { status: patch.status }),
    updatedAt: Math.max(current.updatedAt, now),
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

/** `current` with the fields `patch` sets, stamped `now` unless already later. */
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
    updatedAt: Math.max(current.updatedAt, now),
  };
}
