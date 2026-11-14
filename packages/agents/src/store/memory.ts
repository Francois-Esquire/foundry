import type { SessionMessage, SessionRecord } from "../schema";
import type { SessionStore, SessionStoreWrite } from "./index";

/** The default store: sessions and their messages in plain maps in this process. */
export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, SessionRecord>();
  /** Each session's messages, in the order they were filed. */
  readonly #messages = new Map<string, SessionMessage[]>();
  /** Message id → the session it is filed under. */
  readonly #owners = new Map<string, string>();

  commit(write: SessionStoreWrite): Promise<void> {
    // Clone first so a value that cannot be cloned refuses the whole write.
    let sessions: SessionRecord[];
    let messages: SessionMessage[];
    try {
      sessions = (write.putSessions ?? []).map((s) => structuredClone(s));
      messages = (write.putMessages ?? []).map((m) => structuredClone(m));
    } catch (error) {
      return Promise.reject(error);
    }
    for (const session of sessions) {
      this.#sessions.set(session.id, session);
    }
    for (const message of messages) {
      this.#put(message);
    }
    return Promise.resolve();
  }

  getMessage(id: string): Promise<SessionMessage | null> {
    const owner = this.#owners.get(id);
    const message =
      owner === undefined
        ? undefined
        : this.#messages.get(owner)?.find((m) => m.id === id);
    return Promise.resolve(message ? structuredClone(message) : null);
  }

  getSession(id: string): Promise<SessionRecord | null> {
    const session = this.#sessions.get(id);
    return Promise.resolve(session ? structuredClone(session) : null);
  }

  listMessages(sessionId: string): Promise<SessionMessage[]> {
    const messages = this.#messages.get(sessionId) ?? [];
    return Promise.resolve(messages.map((m) => structuredClone(m)));
  }

  #put(message: SessionMessage): void {
    const owner = this.#owners.get(message.id);
    if (owner === message.sessionId) {
      const bucket = this.#messages.get(owner) ?? [];
      const index = bucket.findIndex((m) => m.id === message.id);
      bucket[index] = message;
      return;
    }
    if (owner !== undefined) {
      const previous = this.#messages.get(owner) ?? [];
      this.#messages.set(
        owner,
        previous.filter((m) => m.id !== message.id)
      );
    }
    const bucket = this.#messages.get(message.sessionId) ?? [];
    bucket.push(message);
    this.#messages.set(message.sessionId, bucket);
    this.#owners.set(message.id, message.sessionId);
  }
}
