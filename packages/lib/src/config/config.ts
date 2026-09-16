/**
 * Config — flat dot-notation runtime configuration store.
 *
 * Mental model: one VS Code-style settings store. Packages contribute
 * typed slices via top-level prefixes; consumers read by dot-path or
 * by prefix-as-object, and subscribe at any granularity (exact key,
 * prefix glob, or whole prefix).
 *
 * Storage, reads, leaf-level + glob events are inherited from
 * `ReactiveStore`. Config layers schema validation, per-prefix
 * defaults, and whole-prefix events with a `source` tag on top.
 *
 * Config is IO-free: it never reads or writes disk. Hosts ingest a
 * pre-parsed payload via `loadFromData` (the desktop from its store, the
 * CLI from a config file it scans) and persist `snapshot()` however they
 * like.
 *
 * Two composition models, distinct by *who owns the storage*:
 *
 *   contribute(prefix, schema, defaults)  — a PARENT-OWNED slice. This Config
 *     holds the values and validates them against the prefix schema.
 *   mount(prefix, child)                  — a CHILD-OWNED slice. The child
 *     ReactiveStore keeps owning (and validating) its own storage; this Config
 *     binds a reference under `prefix` and delegates reads/writes/events to it.
 *     Nothing is copied — `detach` (or override) leaves the child fully intact.
 *
 * Public surface:
 *
 *   contribute(prefix, schema, defaults)   — register a parent-owned typed slice
 *   mount(prefix, child) / detach(prefix)  — bind/unbind a child-owned node
 *   get(path)                              — read by dot-path or prefix
 *   set(path, value)                       — write a single key (sync, validated)
 *   merge(object)                          — write multiple keys (sync, validated)
 *   reset(prefix?)                         — restore defaults (sync)
 *   loadFromData(payload)                  — apply a pre-parsed payload + fan-in (sync)
 *   on(event, handler)                     — exact key, "prefix.*" glob, or "prefix"
 *   snapshot()                             — { [prefix]: value }
 *   contributed()                          — list of registered prefixes
 */

import type { ZodType } from "zod";

import type { LeafChange } from "./helpers";
import {
  deepMergePreserveUndefined,
  setDeepPreserveUndefined,
} from "./helpers";
import type { CommitInfo } from "./reactive-store";
import { ReactiveStore } from "./reactive-store";
import type {
  ChangeSource,
  ConfigChangePayload,
  ConfigShape,
  LoadedPayload,
  Path,
  ValueAt,
} from "./types";

interface PrefixEntry {
  readonly defaults: unknown;
  readonly schema: ZodType;
}

export class Config extends ReactiveStore<Record<string, unknown>> {
  readonly #prefixes = new Map<string, PrefixEntry>();
  /** Child-owned slices bound via {@link mount}, keyed by prefix. */
  readonly #mounts = new Map<string, ReactiveStore<Record<string, unknown>>>();
  #currentSource: ChangeSource = "set";

  // ── Mounting (child-owned slices) ──────────────────────────────────────────

  /**
   * Bind a child-owned node under `prefix`. The child keeps owning and
   * validating its storage; this Config delegates `prefix.*` reads/writes to it
   * and re-emits its commits under the prefix. Nothing is copied.
   *
   * Conflict policy:
   *   - same instance already mounted here → no-op (idempotent).
   *   - a *different* child already mounted here → warn + override; the old
   *     child is detached but stays fully alive (its owner keeps it).
   *   - prefix already taken by a `contribute`d slice → throw (the two
   *     ownership models can't share a prefix — almost always a wiring bug).
   */
  mount(prefix: string, child: ReactiveStore<Record<string, unknown>>): void {
    if (prefix.includes(".")) {
      throw new Error(
        `[foundry/config] mount prefix must be a single segment, got "${prefix}"`
      );
    }
    if (this.#prefixes.has(prefix)) {
      throw new Error(
        `[foundry/config] prefix "${prefix}" is already contributed — ` +
          `a parent-owned slice and a mounted child can't share a prefix`
      );
    }
    const existing = this.#mounts.get(prefix);
    if (existing === child) {
      return;
    }
    if (existing) {
      console.warn(
        `[foundry/config] prefix "${prefix}" is already mounted — overriding ` +
          "(the previous child is detached but stays alive)"
      );
      existing.attachRelay(null);
    }
    this.#mounts.set(prefix, child);
    child.attachRelay((info) => {
      this.#onChildCommit(prefix, info);
    });
  }

  /**
   * Unbind the child mounted at `prefix`. The child keeps all of its data and
   * stays usable standalone — only the forwarding relay is severed. No-op if
   * nothing is mounted there.
   */
  detach(prefix: string): void {
    const child = this.#mounts.get(prefix);
    if (!child) {
      return;
    }
    child.attachRelay(null);
    this.#mounts.delete(prefix);
  }

  // ── Contribution ─────────────────────────────────────────────────────────

  /**
   * Register a typed slice under `prefix`. Schema validates every write
   * to that prefix; defaults seed the initial value. Throws if `prefix`
   * is already registered.
   */
  contribute<T>(prefix: string, schema: ZodType<T>, defaults: T): void {
    if (prefix.includes(".")) {
      throw new Error(
        `[foundry/config] prefix must be a single segment, got "${prefix}"`
      );
    }
    if (this.#prefixes.has(prefix)) {
      throw new Error(
        `[foundry/config] prefix "${prefix}" already contributed`
      );
    }
    if (this.#mounts.has(prefix)) {
      throw new Error(
        `[foundry/config] prefix "${prefix}" is already mounted — ` +
          `a parent-owned slice and a mounted child can't share a prefix`
      );
    }
    this.#prefixes.set(prefix, { defaults, schema });
    // Seed silently — subscribers shouldn't see contribute() as a "change".
    this._values = { ...this._values, [prefix]: defaults };
  }

  /**
   * Registered prefixes — both `contribute`d (parent-owned) and `mount`ed
   * (child-owned), in registration order: contributions first, then mounts.
   */
  contributed(): readonly string[] {
    return [...this.#prefixes.keys(), ...this.#mounts.keys()];
  }

  /**
   * Read by dot-path. Returns the value at `"prefix"` (the whole prefix
   * object), at `"prefix.a.b"` (a nested leaf), or `undefined` if any
   * segment is missing. Typed by the augmented `ConfigShape` interface.
   */
  override get<P extends Path>(path: P): ValueAt<ConfigShape, P>;
  override get(path: string): unknown;
  override get(path: string): unknown {
    const [head] = path.split(".");
    const child = head ? this.#mounts.get(head) : undefined;
    if (head && child) {
      const rest = path.slice(head.length + 1);
      // Whole-prefix read returns the child's live values; nested reads delegate.
      return rest ? child.get(rest) : child.values;
    }
    return super.get(path);
  }

  /**
   * Snapshot keyed by prefix — contributed slices from local storage, mounted
   * slices from each child's live values (the child owns the truth).
   */
  snapshot(): { readonly [K in keyof ConfigShape]: ConfigShape[K] } & Record<
    string,
    unknown
  > {
    const out: Record<string, unknown> = {};
    for (const prefix of this.#prefixes.keys()) {
      out[prefix] = this._values[prefix];
    }
    for (const [prefix, child] of this.#mounts) {
      out[prefix] = child.values;
    }
    return out;
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  /**
   * Write a single value at a dot-path. Validates the entire prefix
   * after the deep-set; on validation failure the stored value is
   * untouched and the call throws.
   */
  override set<P extends Path>(path: P, value: ValueAt<ConfigShape, P>): void;
  override set(path: string, value: unknown): void;
  override set(path: string, value: unknown): void {
    const [prefix, ...rest] = path.split(".");
    if (!prefix) {
      throw new Error("[foundry/config] set requires a non-empty path");
    }
    const child = this.#mounts.get(prefix);
    if (child) {
      if (rest.length === 0) {
        throw new Error(
          `[foundry/config] cannot set the whole mounted prefix "${prefix}" — ` +
            "mutate a nested path, or re-mount to replace the node"
        );
      }
      // The child validates against its own schema and forwards back to us.
      child.set(rest.join("."), value);
      return;
    }
    const entry = this.#requirePrefix(prefix);
    const current = this._values[prefix];
    const candidate =
      rest.length === 0
        ? value
        : setDeepPreserveUndefined(current, rest, value);
    const validated = entry.schema.parse(candidate);
    this.#commitPrefix(prefix, validated, "set");
  }

  /**
   * Object-form multi-key write. The patch is grouped by top-level
   * prefix; each prefix is validated and committed in turn.
   */
  merge(patch: Partial<ConfigShape> | Record<string, unknown>): void {
    for (const [prefix, sub] of Object.entries(patch)) {
      if (sub === undefined) {
        continue;
      }
      const child = this.#mounts.get(prefix);
      if (child) {
        // Delegate to the child — it owns this subtree's storage + validation.
        child.patch(sub as Record<string, unknown>);
        continue;
      }
      const entry = this.#prefixes.get(prefix);
      if (!entry) {
        console.warn(
          `[foundry/config] unknown prefix "${prefix}" in merge — skipping`
        );
        continue;
      }
      const current = this._values[prefix];
      const candidate = deepMergePreserveUndefined(current, sub);
      const validated = entry.schema.parse(candidate);
      this.#commitPrefix(prefix, validated, "merge");
    }
  }

  /**
   * Restore defaults. With no argument, resets every *contributed* prefix —
   * mounted children are independently owned and left untouched (reset them via
   * their own owner). With a prefix, resets that contributed slice, or delegates
   * to the child if `prefix` is mounted.
   */
  override reset(prefix?: string): void {
    if (prefix === undefined) {
      for (const p of this.#prefixes.keys()) {
        this.#commitPrefix(p, this.#requirePrefix(p).defaults, "reset");
      }
      return;
    }
    const child = this.#mounts.get(prefix);
    if (child) {
      child.reset();
      return;
    }
    this.#commitPrefix(prefix, this.#requirePrefix(prefix).defaults, "reset");
  }

  // ── Loaders ──────────────────────────────────────────────────────────────

  /**
   * Apply a pre-parsed payload (e.g. from a tRPC settings save, the desktop
   * store, or a config file the CLI scanned) to contributed prefixes. The
   * single ingestion door — Config never reads disk itself. Unknown prefixes
   * are warned and skipped; a prefix that fails validation keeps its previous
   * value. Emits `"loaded"`.
   */
  loadFromData(
    data: Partial<ConfigShape> | Record<string, unknown>
  ): LoadedPayload {
    return this.#load(data);
  }

  // ── Event extension points ───────────────────────────────────────────────

  protected override onCommit(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    changes: LeafChange[]
  ): void {
    // Whole-prefix event(s) first, one per touched prefix.
    const prefixesTouched = new Set<string>();
    for (const c of changes) {
      const [prefix] = c.path.split(".");
      if (prefix) {
        prefixesTouched.add(prefix);
      }
    }
    for (const prefix of prefixesTouched) {
      const payload: ConfigChangePayload = {
        after: after[prefix],
        before: before[prefix],
        path: prefix,
        source: this.#currentSource,
      };
      this.emit(prefix, payload);
    }
    // Then default leaf + glob fan-out (uses `makeLeafPayload` below).
    super.onCommit(before, after, changes);
  }

  protected override makeLeafPayload(change: LeafChange): ConfigChangePayload {
    return { ...change, source: this.#currentSource };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Commit `value` to a contributed prefix through the base store, stamping
   * the change `source` first. The single place `#currentSource` is written —
   * every contributed write funnels here, so the override hooks (`onCommit` /
   * `makeLeafPayload`) always read a source set immediately before the commit.
   */
  #commitPrefix(prefix: string, value: unknown, source: ChangeSource): void {
    this.#currentSource = source;
    super.set(prefix, value);
  }

  #load(data: Record<string, unknown>): LoadedPayload {
    const applied: string[] = [];
    for (const [prefix, raw] of Object.entries(data)) {
      const child = this.#mounts.get(prefix);
      if (child) {
        // Hand the subtree to the child — it owns ingestion + validation.
        child.patch(raw as Record<string, unknown>);
        applied.push(prefix);
        continue;
      }
      const entry = this.#prefixes.get(prefix);
      if (!entry) {
        console.warn(
          `[foundry/config] unknown prefix "${prefix}" in loaded payload — skipping`
        );
        continue;
      }
      try {
        const validated = entry.schema.parse(raw);
        this.#commitPrefix(prefix, validated, "load");
        applied.push(prefix);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[foundry/config] failed to load prefix "${prefix}": ${message} — keeping previous value`
        );
      }
    }
    const payload: LoadedPayload = { applied };
    this.emit("loaded", payload);
    return payload;
  }

  /**
   * Relay a mounted child's commit as this Config's own namespaced events:
   * whole-store `"changed"`, the whole-prefix event, and per-leaf + glob
   * fan-out under `prefix`. The child's `source` rides along on its payloads
   * (a plain `ReactiveStore` child has none → defaults to `"set"`). Fires only
   * for the changed child; data still lives solely in the child.
   */
  #onChildCommit(
    prefix: string,
    { before, after, changes, payloadFor }: CommitInfo<Record<string, unknown>>
  ): void {
    // Assemble a faithful whole-store view for "changed" without persisting it:
    // all current values (the changed child already committed), with the
    // changed prefix swapped back to its pre-commit value for `before`.
    const assembledAfter: Record<string, unknown> = { ...this._values };
    for (const [p, c] of this.#mounts) {
      assembledAfter[p] = c.values;
    }
    const assembledBefore = { ...assembledAfter, [prefix]: before };
    this.emit("changed", assembledAfter, assembledBefore);

    const [first] = changes;
    const source: ChangeSource =
      (first && (payloadFor(first) as { source?: ChangeSource }).source) ??
      "set";

    const prefixPayload: ConfigChangePayload = {
      after,
      before,
      path: prefix,
      source,
    };
    this.emit(prefix, prefixPayload);

    for (const change of changes) {
      const childPayload = payloadFor(change) as { source?: ChangeSource };
      const path = `${prefix}.${change.path}`;
      const payload: ConfigChangePayload = {
        after: change.after,
        before: change.before,
        path,
        source: childPayload.source ?? source,
      };
      this.emitLeafAndGlobs(path, payload);
    }
  }

  #requirePrefix(prefix: string): PrefixEntry {
    const entry = this.#prefixes.get(prefix);
    if (!entry) {
      throw new Error(
        `[foundry/config] prefix "${prefix}" is not contributed — call config.contribute(...) first`
      );
    }
    return entry;
  }
}
