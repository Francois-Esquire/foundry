import { type EventListener, ListenerMap } from "./emitter";
import type { LeafChange } from "./helpers";
import {
  deepMergeClearUndefined,
  getDeep,
  leafDiff,
  setDeepClearUndefined,
} from "./helpers";
import type { DeepPartial, Path, ValueAt } from "./types";

export interface LeafChangePayload {
  after: unknown;
  before: unknown;
  path: string;
}

export interface CommitInfo<T> {
  after: T;
  before: T;
  changes: LeafChange[];
  payloadFor: (change: LeafChange) => LeafChange;
}

export type CommitRelay<T> = (info: CommitInfo<T>) => void;

export interface ReactiveStoreEventMap<T> {
  changed: [next: Readonly<T>, prev: Readonly<T>];
  // biome-ignore lint/suspicious/noExplicitAny: Runtime event paths allow subclasses to provide distinct listener payload types.
  [key: string]: any[];
}

export class ReactiveStore<T extends object> {
  protected _initial: T;
  protected _values: T;
  #relay: CommitRelay<T> | null = null;
  readonly #listeners = new ListenerMap();

  constructor(initial: T = {} as T) {
    this._initial = structuredClone(initial);
    this._values = structuredClone(initial);
  }

  on<K extends keyof ReactiveStoreEventMap<T> & string>(
    event: K,
    listener: (...args: ReactiveStoreEventMap<T>[K]) => void
  ): this {
    this.#listeners.on(event, listener as EventListener);
    return this;
  }

  addListener<K extends keyof ReactiveStoreEventMap<T> & string>(
    event: K,
    listener: (...args: ReactiveStoreEventMap<T>[K]) => void
  ): this {
    return this.on(event, listener);
  }

  once<K extends keyof ReactiveStoreEventMap<T> & string>(
    event: K,
    listener: (...args: ReactiveStoreEventMap<T>[K]) => void
  ): this {
    this.#listeners.on(event, listener as EventListener, true);
    return this;
  }

  off<K extends keyof ReactiveStoreEventMap<T> & string>(
    event: K,
    listener: (...args: ReactiveStoreEventMap<T>[K]) => void
  ): this {
    this.#listeners.off(event, listener as EventListener);
    return this;
  }

  removeListener<K extends keyof ReactiveStoreEventMap<T> & string>(
    event: K,
    listener: (...args: ReactiveStoreEventMap<T>[K]) => void
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

  emit<K extends keyof ReactiveStoreEventMap<T> & string>(
    event: K,
    ...args: ReactiveStoreEventMap<T>[K]
  ): boolean {
    return this.#listeners.emit(event, this, args);
  }

  /** @internal */
  attachRelay(relay: CommitRelay<T> | null): void {
    this.#relay = relay;
  }

  get values(): Readonly<T> {
    return this._values;
  }

  get<P extends Path<T>>(path: P): ValueAt<T, P>;
  get(path: string): unknown;
  get(path: string): unknown {
    if (!path) {
      return undefined;
    }
    return getDeep(this._values, path.split("."));
  }

  set<P extends Path<T>>(path: P, value: ValueAt<T, P>): void;
  set(path: string, value: unknown): void;
  set(path: string, value: unknown): void {
    if (!path) {
      return;
    }
    const prev = this._values;
    const next = setDeepClearUndefined(prev, path.split("."), value) as T;
    this.commit(prev, next);
  }

  patch(patch: DeepPartial<T>): void {
    const prev = this._values;
    const next = deepMergeClearUndefined(prev, patch) as T;
    this.commit(prev, next);
  }

  reset(): void {
    const prev = this._values;
    const next = structuredClone(this._initial);
    this.commit(prev, next);
  }

  protected commit(before: T, after: T): void {
    const changes = [...leafDiff("", before, after)];
    if (changes.length === 0) {
      return;
    }
    this._values = after;
    this.onCommit(before, after, changes);
    this.#relay?.({
      after,
      before,
      changes,
      payloadFor: (change) => this.makeLeafPayload(change),
    });
  }

  protected onCommit(before: T, after: T, changes: LeafChange[]): void {
    this.emit("changed", after, before);
    for (const change of changes) {
      this.emitLeafAndGlobs(change.path, this.makeLeafPayload(change));
    }
  }

  protected emitLeafAndGlobs(path: string, payload: unknown): void {
    this.emit(path, payload);
    const segments = path.split(".");
    for (let i = 1; i < segments.length; i += 1) {
      const glob = `${segments.slice(0, i).join(".")}.*`;
      if (this.listenerCount(glob) > 0) {
        this.emit(glob, payload);
      }
    }
  }

  protected makeLeafPayload(change: LeafChange): LeafChange {
    return change;
  }
}
