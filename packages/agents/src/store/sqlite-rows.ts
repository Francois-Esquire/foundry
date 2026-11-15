import type { SessionChangeEvent } from "../schema";
import { ownedEvents } from "./events";
import type { SessionStoreWrite } from "./index";
import { below, keptMessage, keptSession, RecordFault } from "./sqlite-records";
import type { agentMessages, agentSessions } from "./tables";

/**
 * How `SqliteSessionStore` turns a write into rows; `./sqlite-decode` turns
 * rows back. Each record passes the checks in `./sqlite-records`, the same
 * ones a decoded row passes, before any statement runs. `Sessions` hands a
 * store only kept messages, so this is the last line of defence against a
 * caller that writes past it.
 */

/** A session row, `scope` included. */
export type SessionRow = typeof agentSessions.$inferSelect;

/** A message row before the commit places it in its session. */
export type UnplacedMessageRow = Omit<
  typeof agentMessages.$inferSelect,
  "position"
>;

/** A write taken over by the store, and the rows it puts, in its order. */
export interface OwnedWrite {
  readonly messages: readonly UnplacedMessageRow[];
  readonly sessions: readonly SessionRow[];
  /** The store's own copy of the write: what it writes and what `onCommit` receives. */
  readonly write: SessionStoreWrite;
}

/**
 * `write` as the store's own copy, taken now and read once, and the rows it
 * puts in `scope`. Throws a `RangeError` naming the first field SQLite would
 * not give back intact, such as `putMessages[2].role` or
 * `putMessages[0].parts[3].output.items[1]`; a field that throws when read
 * rejects the write too. The copy shares nothing with `write`, so a caller
 * changing `write` afterwards changes neither the rows nor what `onCommit`
 * sees.
 */
export function owned(scope: string, write: SessionStoreWrite): OwnedWrite {
  const taken = captured(write);
  const messages = taken.putMessages ?? [];
  const sessions = taken.putSessions ?? [];
  return {
    messages: messages.map((message) => ({
      createdAt: message.createdAt,
      id: message.id,
      metadata: message.metadata ?? null,
      parts: message.parts,
      role: message.role,
      scope,
      sessionId: message.sessionId,
      status: message.status,
      summarized: message.summarized ?? null,
      updatedAt: message.updatedAt,
    })),
    sessions: sessions.map((session) => ({
      createdAt: session.createdAt,
      id: session.id,
      parentMessageId: session.parentMessageId ?? null,
      parentSessionId: session.parentSessionId ?? null,
      recursionDepth: session.recursionDepth ?? null,
      scope,
      status: session.status,
      title: session.title,
      updatedAt: session.updatedAt,
    })),
    write: taken,
  };
}

/**
 * `write` as the store's own copy, without the rows: each record read once,
 * now, and checked as `owned` checks it, throwing the same errors. The copy
 * shares nothing with `write`.
 */
export function captured(write: SessionStoreWrite): SessionStoreWrite {
  const sessions = write.putSessions?.map((session, index) =>
    stored(`putSessions[${index}]`, () => keptSession(session))
  );
  const messages = write.putMessages?.map((message, index) =>
    stored(`putMessages[${index}]`, () => keptMessage(message))
  );
  const events = ownedEvents<SessionChangeEvent>(write.events);
  return {
    ...(events === undefined ? {} : { events }),
    ...(messages === undefined ? {} : { putMessages: messages }),
    ...(sessions === undefined ? {} : { putSessions: sessions }),
  };
}

/** `keep()`, with a {@link RecordFault} named below `at` as a refusal to store. */
function stored<T>(at: string, keep: () => T): T {
  try {
    return keep();
  } catch (error) {
    if (error instanceof RecordFault) {
      throw new RangeError(
        `SqliteSessionStore cannot store ${below(at, error.path)}: ${error.reason}`,
        { cause: error }
      );
    }
    throw error;
  }
}
