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
  id?: string;
  parentMessageId?: string;
  parentSessionId?: string;
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
  readonly store?: SessionStore;
}

export class Sessions {
  readonly #store: SessionStore;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: SessionsOptions = {}) {
    this.#store = options.store ?? new InMemorySessionStore();
  }

  getSession(id: string): Promise<SessionRecord | null> {
    return this.#store.getSession(id);
  }

  listMessages(sessionId: string): Promise<SessionMessage[]> {
    return this.#store.listMessages(sessionId);
  }

  async activeMessages(sessionId: string): Promise<SessionMessage[]> {
    return activeView(await this.#store.listMessages(sessionId));
  }

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

  appendMessageIf(
    input: CreateMessageInput,
    admits: (history: readonly SessionMessage[]) => boolean
  ): Promise<SessionMessage | undefined> {
    let message: SessionMessage;
    try {
      message = keptMessage(newSessionMessage(input));
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#mutation(async (store) => {
      const session = await store.getSession(message.sessionId);
      if (!session) {
        throw new Error(`[sessions] unknown session: ${message.sessionId}`);
      }
      if (!admits(await store.listMessages(message.sessionId))) {
        return;
      }
      await store.commit({
        putMessages: [message],
        putSessions: [touched(session, message)],
      });
      return message;
    });
  }

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

function changeEvent(
  type: "session.created" | "session.updated",
  sessionId: string,
  at: number,
  id: string = generateId()
): SessionChangeEvent {
  return { at: new Date(at).toISOString(), id, sessionId, type };
}

function messagesAppended(message: SessionMessage): SessionChangeEvent {
  return {
    at: new Date(message.createdAt).toISOString(),
    id: generateId(),
    messageIds: [message.id],
    sessionId: message.sessionId,
    type: "session.messages.appended",
  };
}

function touched(
  session: SessionRecord,
  message: SessionMessage
): SessionRecord {
  return keptSession({
    ...session,
    updatedAt: Math.max(session.updatedAt, message.createdAt),
  });
}

function keptSession(record: SessionRecord): SessionRecord {
  return withoutUndefined(record);
}

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
  const fault = patch.parts === undefined ? undefined : partsFault(kept.parts);
  if (fault !== undefined) {
    throw new TypeError(
      `[sessions] cannot keep message ${id}: ${fault.path} ${fault.reason}`
    );
  }
  return kept;
}

function withoutUndefined<T extends object>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined)
  ) as T;
}

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
