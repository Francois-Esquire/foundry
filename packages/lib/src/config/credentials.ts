import { type EventListener, ListenerMap } from "./emitter";
import type { CredentialsChangePayload } from "./types";

// biome-ignore lint/suspicious/noEmptyInterface: Consumers extend this interface through declaration merging.
export interface CredentialsVault {}

export interface CredentialsEventMap {
  changed: [payload: CredentialsChangePayload<CredentialsVault>];
  // biome-ignore lint/suspicious/noExplicitAny: Preserve EventEmitter compatibility for custom event names.
  [key: string]: any[];
}

export class Credentials {
  #vault: CredentialsVault;
  readonly #listeners = new ListenerMap();

  constructor(initial?: CredentialsVault) {
    this.#vault = { ...initial };
  }

  on<K extends keyof CredentialsEventMap & string>(
    event: K,
    listener: (...args: CredentialsEventMap[K]) => void
  ): this {
    this.#listeners.on(event, listener as EventListener);
    return this;
  }

  addListener<K extends keyof CredentialsEventMap & string>(
    event: K,
    listener: (...args: CredentialsEventMap[K]) => void
  ): this {
    return this.on(event, listener);
  }

  once<K extends keyof CredentialsEventMap & string>(
    event: K,
    listener: (...args: CredentialsEventMap[K]) => void
  ): this {
    this.#listeners.on(event, listener as EventListener, true);
    return this;
  }

  off<K extends keyof CredentialsEventMap & string>(
    event: K,
    listener: (...args: CredentialsEventMap[K]) => void
  ): this {
    this.#listeners.off(event, listener as EventListener);
    return this;
  }

  removeListener<K extends keyof CredentialsEventMap & string>(
    event: K,
    listener: (...args: CredentialsEventMap[K]) => void
  ): this {
    return this.off(event, listener);
  }

  removeAllListeners(event?: string): this {
    this.#listeners.removeAll(event);
    return this;
  }

  listenerCount(event: string): number {
    return this.#listeners.count(event);
  }

  emit<K extends keyof CredentialsEventMap & string>(
    event: K,
    ...args: CredentialsEventMap[K]
  ): boolean {
    return this.#listeners.emit(event, this, args);
  }

  get(): Readonly<CredentialsVault> {
    return this.#vault;
  }

  set(patch: Partial<CredentialsVault>): void {
    const before = this.#vault;
    const after: Record<string, unknown> = { ...before };
    const entries: [string, unknown][] = Object.entries(patch);
    for (const [key, value] of entries) {
      if (value === undefined) {
        continue;
      }
      if (value === null) {
        Reflect.deleteProperty(after, key);
      } else {
        after[key] = value;
      }
    }
    const next = after as CredentialsVault;
    this.#vault = next;
    const payload: CredentialsChangePayload<CredentialsVault> = {
      after: next,
      before,
    };
    this.emit("changed", payload);
  }

  clear(): void {
    const before = this.#vault;
    const next: CredentialsVault = {};
    this.#vault = next;
    const payload: CredentialsChangePayload<CredentialsVault> = {
      after: next,
      before,
    };
    this.emit("changed", payload);
  }
}

export type CredentialsChange = CredentialsChangePayload<CredentialsVault>;
