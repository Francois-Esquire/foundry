import { Turns } from "@foundry/lib/turns";

import type { SessionMessage, SessionRecord } from "../schema";
import { ownedEvents } from "./events";
import type { SessionStore, SessionStoreWrite } from "./index";

const REENTRY =
  "InMemorySessionStore was called from inside its own transaction; use the view passed to the transaction's work instead";

export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #messages = new Map<string, readonly SessionMessage[]>();
  readonly #owners = new Map<string, string>();
  readonly #turns = new Turns(REENTRY);

  commit(write: SessionStoreWrite): Promise<void> {
    let copied: Copied;
    try {
      copied = copyOf(write);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#turns.run(() => {
      this.#apply(copied);
      return Promise.resolve();
    });
  }

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

  #apply({ messages, sessions }: Copied): void {
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

interface Copied {
  readonly messages: readonly SessionMessage[];
  readonly sessions: readonly SessionRecord[];
}

function copyOf(write: SessionStoreWrite): Copied {
  ownedEvents(write.events);
  return {
    messages: (write.putMessages ?? []).map((m) => structuredClone(m)),
    sessions: (write.putSessions ?? []).map((s) => structuredClone(s)),
  };
}

function replaceEntries<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>) {
  const entries = [...source];
  target.clear();
  for (const [key, value] of entries) {
    target.set(key, value);
  }
}
