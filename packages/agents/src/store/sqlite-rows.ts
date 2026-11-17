import type { SessionChangeEvent } from "../schema";
import { ownedEvents } from "./events";
import type { SessionStoreWrite } from "./index";
import { below, keptMessage, keptSession, RecordFault } from "./sqlite-records";
import type { agentMessages, agentSessions } from "./tables";

export type SessionRow = typeof agentSessions.$inferSelect;

export type UnplacedMessageRow = Omit<
  typeof agentMessages.$inferSelect,
  "position"
>;

export interface OwnedWrite {
  readonly messages: readonly UnplacedMessageRow[];
  readonly sessions: readonly SessionRow[];
  readonly write: SessionStoreWrite;
}

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
