import { EventEmitter } from "node:events";

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

/**
 * Everything a parent needs to forward a child's commit, handed to the relay
 * after the child has emitted its own events. `payloadFor` rebuilds the exact
 * per-leaf payload the child emitted (carrying its `source` tag for a `Config`
 * child) so the parent re-emits with the child's source, not a re-derived one.
 */
export interface CommitInfo<T> {
  after: T;
  before: T;
  changes: LeafChange[];
  payloadFor: (change: LeafChange) => LeafChange;
}

/** Forwarder invoked once per commit. Wired by `Config.mount`. */
export type CommitRelay<T> = (info: CommitInfo<T>) => void;

/**
 * Event map for `ReactiveStore`. `"changed"` is typed; arbitrary
 * dot-path event names fall through the index signature.
 */
export interface ReactiveStoreEventMap<T> {
  changed: [next: Readonly<T>, prev: Readonly<T>];
  // Per-path / glob event payloads can't be statically typed (paths are
  // runtime strings); `any[]` lets subclasses ship specific listener
  // shapes (e.g. `Config`'s `ConfigChangePayload`).
  // biome-ignore lint/suspicious/noExplicitAny: Runtime event paths allow subclasses to provide distinct listener payload types.
  [key: string]: any[];
}

/**
 * Typed, observable bag with dot-path reads/writes and granular change
 * events. Minimal — no schema validation, no async commits, no file
 * loading. Reach for `Config` when you need any of those.
 *
 * Events:
 *   - `"changed"`     → (next, prev)               // fires on any mutation
 *   - `"<dot.path>"`  → ({ path, before, after })  // exact leaf changed
 *   - `"<prefix>.*"`  → ({ path, before, after })  // any leaf under prefix
 *
 * `set(path, undefined)` clears the leaf; `patch({key: undefined})`
 * clears `key`. Same for any depth.
 */
export class ReactiveStore<T extends object> extends EventEmitter<
  ReactiveStoreEventMap<T>
> {
  protected _initial: T;
  protected _values: T;
  #relay: CommitRelay<T> | null = null;

  constructor(initial: T = {} as T) {
    super();
    this._initial = structuredClone(initial);
    this._values = structuredClone(initial);
  }

  /**
   * @internal Wire (or clear, with `null`) a forwarder invoked after every
   * commit. `Config.mount` uses this to relay a mounted child's changes up
   * under its prefix; `detach`/override clears it. Not for application use —
   * a node forwards to at most one parent.
   */
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

  /** Restore the constructor-provided initial values. */
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
    // Forward to a mounting parent (if any) after local emits, so the parent's
    // namespaced events fire in the same turn as the child's own.
    this.#relay?.({
      after,
      before,
      changes,
      payloadFor: (change) => this.makeLeafPayload(change),
    });
  }

  /**
   * Subclass extension point. Default fires `"changed"`, then per-leaf
   * exact-path + ancestor-prefix glob events. Override to add prefix-
   * scoped events or otherwise customize fan-out — call `super.onCommit`
   * to keep the default leaf/glob behavior.
   */
  protected onCommit(before: T, after: T, changes: LeafChange[]): void {
    this.emit("changed", after, before);
    for (const change of changes) {
      this.emitLeafAndGlobs(change.path, this.makeLeafPayload(change));
    }
  }

  /**
   * Emit a leaf's exact-path event plus every ancestor `prefix.*` glob that
   * currently has listeners. Shared by the local commit fan-out and the
   * mounted-child relay (`Config.#onChildCommit`) so the glob-walk lives in
   * exactly one place.
   */
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

  /**
   * Subclass extension point. Default returns the leaf change as-is.
   * Override to stamp additional fields (e.g. a `source` discriminator)
   * onto every per-path / glob emit.
   */
  protected makeLeafPayload(change: LeafChange): LeafChange {
    return change;
  }
}
