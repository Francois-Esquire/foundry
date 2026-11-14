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
 * store. Every write `Sessions` builds changes one session, so a store may
 * keep each session apart. Values crossing this seam are detached.
 */
export interface SessionStore {
  commit(write: SessionStoreWrite): Promise<void>;
  getMessage(id: string): Promise<SessionMessage | null>;
  getSession(id: string): Promise<SessionRecord | null>;
  /** A session's messages in the order they were filed; empty for an unknown session. */
  listMessages(sessionId: string): Promise<SessionMessage[]>;
  /**
   * Runs one read-modify-write so that no other write to the store lands
   * between its reads and its commit, from any `Sessions` over the store.
   * `work` reads and commits through `view` only, touches one session, and
   * commits at most once, last. Without it, mutations are serialized per
   * `Sessions` instance and no further.
   */
  transaction?<T>(work: (view: SessionStore) => Promise<T>): Promise<T>;
}
