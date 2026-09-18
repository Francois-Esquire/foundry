import type { WorkspaceCtor } from "./instance";
import type { StoredWorkspaceRecord } from "./workspace-store";

export type WorkspaceIdentity = Pick<
  StoredWorkspaceRecord,
  "name" | "source" | "sourceId" | "path"
>;

/**
 * One layer the system may wrap around a Workspace at open.
 *
 * `applies` is asked with the stored record alone; `wrap` is a class mixin.
 * Layers are applied in registration order, each extending the class the
 * previous one returned, so `super` runs the whole chain. The layer that
 * answers `scan`/`readFile`/`writeFile` must come first for its source;
 * anything after it only adds.
 *
 * The three type parameters are what the system accumulates through
 * `extend`, so a composed system's `add` and `open` are typed by the layers
 * it holds:
 *
 * - `Ref` — what `add` accepts for this layer's source (`{ path }`). Only a
 *   floor has one; `ref` names the key the system dispatches on.
 * - `Floor` — what `add(ref)` returns beyond the root (`DirectoryCapable`).
 * - `Cap` — what every opened Workspace carries. A layer that applies per
 *   record declares it optional (`{ git?: Git }`).
 */
export interface WorkspaceExtension<
  Ref extends object = never,
  Floor = unknown,
  Cap = unknown,
> {
  applies: (record: StoredWorkspaceRecord) => Promise<boolean> | boolean;
  identify?(ref: Ref): Promise<WorkspaceIdentity> | WorkspaceIdentity;
  readonly name: string;
  /** The key of `Ref` that names this layer's source. Absent on an additive layer. */
  readonly ref?: string;
  /** Never set; carries `Floor` and `Cap` for the system's typing. */
  readonly types?: { readonly floor: Floor; readonly cap: Cap };
  wrap: (Base: WorkspaceCtor) => WorkspaceCtor;
}

export type AnyWorkspaceExtension = WorkspaceExtension<object>;

export type RefOf<Exts extends readonly AnyWorkspaceExtension[]> =
  Exts[number] extends infer E
    ? E extends WorkspaceExtension<infer R>
      ? R
      : never
    : never;

export type FloorFor<
  Exts extends readonly AnyWorkspaceExtension[],
  R,
> = Exts[number] extends infer E
  ? E extends WorkspaceExtension<infer Ref, infer Floor>
    ? R extends Ref
      ? Floor
      : never
    : never
  : never;

/** What every Workspace a system opens carries: the intersection of each layer's `Cap`. */
export type CapOf<Exts extends readonly AnyWorkspaceExtension[]> =
  UnionToIntersection<
    Exts[number] extends infer E
      ? E extends WorkspaceExtension<never, unknown, infer Cap>
        ? unknown extends Cap
          ? never // a layer with no `Cap` would absorb the union
          : Cap
        : never
      : never
  >;

type UnionToIntersection<U> = (
  U extends unknown
    ? (member: U) => void
    : never
) extends (member: infer I) => void
  ? I
  : unknown;
