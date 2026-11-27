import type { Page, PageInput } from "@foundry/core/pagination";
import type {
  SessionChangeEvent,
  SessionMessage,
  SessionRecord,
  SessionRole,
} from "../schema";

export interface MessagePageQuery extends PageInput<string> {
  readonly role?: SessionRole;
  readonly summarized?: boolean;
}

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
  listMessagesPage?(
    sessionId: string,
    query?: MessagePageQuery
  ): Promise<Page<SessionMessage, string>>;
  transaction?<T>(work: (view: SessionStore) => Promise<T>): Promise<T>;
}
