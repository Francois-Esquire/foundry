/**
 * Public type layer for `@foundry/lib/config`.
 *
 * Two pieces:
 *
 *   - `ConfigShape` — empty, open interface. Every contributing
 *     package widens it via TypeScript declaration merging:
 *
 *     ```ts
 *     declare module "@foundry/lib/config/types" {
 *       interface ConfigShape {
 *         workspaces?: WorkspacesConfig;
 *       }
 *     }
 *     ```
 *
 *     This lets `config.get("workspaces.worktreesSubdir")` resolve to
 *     a typed value without any per-call generic.
 *
 *   - `Path<T>` and `ValueAt<T, P>` — template-literal projections that
 *     turn a nested object type into the union of its dot-paths, and
 *     resolve a dot-path back to the value type at that location.
 */

/**
 * Open-by-design configuration surface. Empty in this package; every
 * contributing package widens it via `declare module` to add its own
 * top-level prefix.
 */
// biome-ignore lint/suspicious/noEmptyInterface: Consumers extend this interface through declaration merging.
export interface ConfigShape {}

/**
 * All dot-paths reachable in `T`. Both intermediate prefixes and leaf
 * keys are included, so consumers can reach `"workspaces"` (the whole
 * prefix as an object) and `"workspaces.scan.maxDepth"` (a leaf).
 */
export type Path<T = ConfigShape> = T extends object
  ? {
      [K in keyof T & string]:
        | K
        | (NonNullable<T[K]> extends object
            ? `${K}.${Path<NonNullable<T[K]>>}`
            : never);
    }[keyof T & string]
  : never;

/**
 * Resolve the value type at `P` within `T`. Walks the dot-path one
 * segment at a time. Returns `unknown` if the path doesn't fit the
 * shape — a deliberate escape hatch so untyped callers compile.
 */
export type ValueAt<
  T,
  P extends string,
> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? NonNullable<T[Head]> extends object
      ? ValueAt<NonNullable<T[Head]>, Rest>
      : unknown
    : unknown
  : P extends keyof T
    ? T[P]
    : unknown;

/**
 * The set of top-level prefixes contributed to `ConfigShape`. Used by
 * loaders / `merge` to type the object form.
 */
// `ConfigShape` is intentionally an empty open interface — packages
// augment it via `declare module`, so `keyof ConfigShape` resolves to
// `never` from this file's POV. The `& string` narrows once augmented.
export type Prefix = keyof ConfigShape & string;

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object | undefined
    ? DeepPartial<NonNullable<T[K]>> | undefined
    : T[K];
};

/**
 * Plain-TS event payload types — the public seam vocabulary.
 *
 * Every change emitted by `Config` carries the same payload shape; the
 * event NAME tells you the granularity:
 *
 *   - exact key: `"queue.concurrency"` — leaf change
 *   - whole prefix: `"workspaces"` — atomic prefix commit
 *   - prefix glob: `"workspaces.*"` — fires once per leaf inside that
 *     prefix on every commit
 *
 * For glob events the `path` is the leaf path that actually changed
 * (e.g. `"workspaces.scan.maxDepth"`); for whole-prefix events the
 * `path` is the prefix itself.
 */

/**
 * Source of a mutation — useful for subscribers that want to
 * differentiate file-load-driven updates from caller-driven mutations
 * (e.g. skip echoing a save).
 */
export type ChangeSource = "set" | "merge" | "reset" | "load";

/** Payload carried by every `Config` `"changed"`-style event. */
export interface ConfigChangePayload<TBefore = unknown, TAfter = unknown> {
  after: TAfter;
  before: TBefore;
  path: string;
  source: ChangeSource;
}

/** Payload for `Config#"loaded"` after a successful `loadFromData`. */
export interface LoadedPayload {
  /** Top-level prefixes that received data from the loaded payload. */
  applied: readonly string[];
}

/** Payload for `Credentials#"changed"`. */
export interface CredentialsChangePayload<T> {
  after: Readonly<T>;
  before: Readonly<T>;
}
