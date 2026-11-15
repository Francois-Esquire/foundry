import type { SessionMessage, SessionRecord } from "../schema";

/**
 * One atomic write. A put replaces the record filed under its id, or files
 * it when the id is new. A new message goes after every message of its
 * session; a replaced one keeps its place.
 */
export interface SessionStoreWrite {
  readonly putMessages?: readonly SessionMessage[];
  readonly putSessions?: readonly SessionRecord[];
}

/**
 * The persistence seam. A store keeps sessions and their messages and applies
 * one write atomically. It enforces nothing: that a message's session exists,
 * that a session is filed once, how a summary folds history are the rules of
 * `Sessions` (`@foundry/agents/session`), checked before a write reaches the
 * store. Values crossing this seam are detached.
 */
export interface SessionStore {
  commit(write: SessionStoreWrite): Promise<void>;
  getMessage(id: string): Promise<SessionMessage | null>;
  getSession(id: string): Promise<SessionRecord | null>;
  /** A session's messages in the order they were filed; empty for an unknown session. */
  listMessages(sessionId: string): Promise<SessionMessage[]>;
  /**
   * Runs one read-modify-write over the whole store. `work` reads and commits
   * through `view` only, any number of times and across any sessions, and:
   * a plain `commit` from outside queues behind it and never lands inside
   * it; if `work` throws, none of its commits stay; reads through `view` see
   * its own commits. Without it, mutations are serialized per `Sessions`
   * instance and no further.
   */
  transaction?<T>(work: (view: SessionStore) => Promise<T>): Promise<T>;
}
