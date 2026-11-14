import { Turns } from "@foundry/lib/turns";

import type { SessionMessage, SessionRecord } from "../schema";
import type { SessionStore, SessionStoreWrite } from "./index";

/** Why a call from inside the store's own transaction is refused. */
const REENTRY =
  "InMemorySessionStore was called from inside its own transaction; use the view passed to the transaction's work instead";

/**
 * The default store: sessions and their messages in plain maps in this
 * process. Every call takes a turn, so a commit made while a transaction
 * runs lands after it, and a call made from inside a transaction's work is
 * refused.
 */
export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, SessionRecord>();
  /** Each session's messages, in the order they were filed. */
  readonly #messages = new Map<string, readonly SessionMessage[]>();
  /** Message id → the session it is filed under. */
  readonly #owners = new Map<string, string>();
  readonly #turns = new Turns(REENTRY);

  commit(write: SessionStoreWrite): Promise<void> {
    return this.#turns.run(() => {
      this.#apply(write);
      return Promise.resolve();
    });
  }

  /**
   * Runs `work` over a draft of the store and keeps the draft only if `work`
   * succeeds, so a throw after a commit through `view` leaves nothing.
   */
  transaction<T>(work: (view: SessionStore) => Promise<T>): Promise<T> {
    return this.#turns.run(async () => {
      const draft = this.#draft();
      const result = await work(draft);
      this.#adopt(draft);
      return result;
    });
  }

  getMessage(id: string): Promise<SessionMessage | null> {
    return this.#turns.run(() => {
      const owner = this.#owners.get(id);
      const message =
        owner === undefined
          ? undefined
          : this.#messages.get(owner)?.find((m) => m.id === id);
      return Promise.resolve(message ? structuredClone(message) : null);
    });
  }

  getSession(id: string): Promise<SessionRecord | null> {
    return this.#turns.run(() => {
      const session = this.#sessions.get(id);
      return Promise.resolve(session ? structuredClone(session) : null);
    });
  }

  listMessages(sessionId: string): Promise<SessionMessage[]> {
    return this.#turns.run(() => {
      const messages = this.#messages.get(sessionId) ?? [];
      return Promise.resolve(messages.map((m) => structuredClone(m)));
    });
  }

  /** A store holding what this one holds; records and lists are never changed in place. */
  #draft(): InMemorySessionStore {
    const draft = new InMemorySessionStore();
    draft.#adopt(this);
    return draft;
  }

  #adopt(source: InMemorySessionStore): void {
    replaceEntries(this.#sessions, source.#sessions);
    replaceEntries(this.#messages, source.#messages);
    replaceEntries(this.#owners, source.#owners);
  }

  #apply(write: SessionStoreWrite): void {
    // Copy first so a value that cannot be copied refuses the whole write.
    const sessions = (write.putSessions ?? []).map((s) => structuredClone(s));
    const messages = (write.putMessages ?? []).map((m) => structuredClone(m));
    for (const session of sessions) {
      this.#sessions.set(session.id, session);
    }
    for (const message of messages) {
      this.#put(message);
    }
  }

  #put(message: SessionMessage): void {
    const owner = this.#owners.get(message.id);
    if (owner !== undefined && owner !== message.sessionId) {
      this.#messages.set(
        owner,
        (this.#messages.get(owner) ?? []).filter((m) => m.id !== message.id)
      );
    }
    const bucket = this.#messages.get(message.sessionId) ?? [];
    const index =
      owner === message.sessionId
        ? bucket.findIndex((m) => m.id === message.id)
        : -1;
    this.#messages.set(
      message.sessionId,
      index === -1
        ? [...bucket, message]
        : bucket.map((m, i) => (i === index ? message : m))
    );
    this.#owners.set(message.id, message.sessionId);
  }
}

/** Makes `target` hold `source`'s entries, in `source`'s order. */
function replaceEntries<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>) {
  const entries = [...source];
  target.clear();
  for (const [key, value] of entries) {
    target.set(key, value);
  }
}
