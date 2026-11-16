import type {
  SessionChangeEvent,
  SessionMessage,
  SessionRecord,
} from "../schema";

export interface SessionStoreWrite {
  readonly events?: readonly SessionChangeEvent[];
  readonly putMessages?: readonly SessionMessage[];
  readonly putSessions?: readonly SessionRecord[];
}

export interface SessionStore {
  commit(write: SessionStoreWrite): Promise<void>;
  getMessage(id: string): Promise<SessionMessage | null>;
  getSession(id: string): Promise<SessionRecord | null>;
  listMessages(sessionId: string): Promise<SessionMessage[]>;
  transaction?<T>(work: (view: SessionStore) => Promise<T>): Promise<T>;
}
