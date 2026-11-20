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
  readonly #mounts = new Map<string, ReactiveStore<Record<string, unknown>>>();
  #currentSource: ChangeSource = "set";

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

  detach(prefix: string): void {
    const child = this.#mounts.get(prefix);
    if (!child) {
      return;
    }
    child.attachRelay(null);
    this.#mounts.delete(prefix);
  }

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
    this._values = { ...this._values, [prefix]: defaults };
  }

  contributed(): readonly string[] {
    return [...this.#prefixes.keys(), ...this.#mounts.keys()];
  }

  override get<P extends Path>(path: P): ValueAt<ConfigShape, P>;
  override get(path: string): unknown;
  override get(path: string): unknown {
    const [head] = path.split(".");
    const child = head ? this.#mounts.get(head) : undefined;
    if (head && child) {
      const rest = path.slice(head.length + 1);
      return rest ? child.get(rest) : child.values;
    }
    return super.get(path);
  }

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

  merge(patch: Partial<ConfigShape> | Record<string, unknown>): void {
    for (const [prefix, sub] of Object.entries(patch)) {
      if (sub === undefined) {
        continue;
      }
      const child = this.#mounts.get(prefix);
      if (child) {
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

  loadFromData(
    data: Partial<ConfigShape> | Record<string, unknown>
  ): LoadedPayload {
    return this.#load(data);
  }

  protected override onCommit(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    changes: LeafChange[]
  ): void {
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
    super.onCommit(before, after, changes);
  }

  protected override makeLeafPayload(change: LeafChange): ConfigChangePayload {
    return { ...change, source: this.#currentSource };
  }

  #commitPrefix(prefix: string, value: unknown, source: ChangeSource): void {
    this.#currentSource = source;
    super.set(prefix, value);
  }

  #load(data: Record<string, unknown>): LoadedPayload {
    const applied: string[] = [];
    for (const [prefix, raw] of Object.entries(data)) {
      const child = this.#mounts.get(prefix);
      if (child) {
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

  #onChildCommit(
    prefix: string,
    { before, after, changes, payloadFor }: CommitInfo<Record<string, unknown>>
  ): void {
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
