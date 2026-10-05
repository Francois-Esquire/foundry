import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { Context, SetupContext } from "./types";

/**
 * What the engine runs. A definition is a record: a body, its schemas, and
 * a name when it can be launched from outside. A locked node places one in
 * a tree, with these children and this literal input. Both are plain data;
 * how a host writes them is its own business.
 */

/** Where the host's source asked for a definition. */
export interface CallSite {
  readonly column: number;
  readonly file: string;
  readonly line: number;
}

export type StepFn<I, O> = (context: Context<I>) => O | Promise<O>;
export type SetupFn<I, O = unknown> = (
  context: SetupContext<I>
) => LockedNode<O> | Promise<LockedNode<O>>;

export interface LockedNode<O = unknown> {
  /** Phantom: the node's output type. */
  readonly __output?: O;
  readonly children: readonly (readonly [string, LockedNode])[];
  readonly definition: AnyDefinition;
  readonly kind: "node";
  readonly literal: Readonly<Record<string, unknown>>;
  readonly mode: "series" | "parallel";
  /** Set on a launch root: the literal is already parsed input. */
  readonly parsed?: boolean;
}

export interface Shared {
  readonly description?: string;
  /** Set when `name` came from the config's `const`, not the call. */
  readonly inferred?: boolean;
  readonly input?: StandardSchemaV1;
  readonly name?: string;
  /** Where the config called the builder; only kept for nameless calls. */
  readonly site?: CallSite;
  /** Set on a nameless definition whose project has no `typescript` to name it from its const. */
  readonly uninferable?: boolean;
}

/**
 * The data of a step definition, without the lock forms. `O` is what a lock
 * of it produces for a parent; the body's own return is validated through
 * `output` first, so it is not typed here.
 */
export interface StepRecord<I = never, O = unknown> extends Shared {
  /** Phantom: the node's output type. */
  readonly __output?: O;
  readonly fn: StepFn<I, unknown>;
  readonly kind: "step";
  readonly output?: StandardSchemaV1;
}

/** The data of a workflow definition: a tree, or setup that returns one. */
export interface WorkflowRecord<I = never> extends Shared {
  readonly kind: "workflow";
  readonly setup: SetupFn<I> | undefined;
  readonly tree: LockedNode | undefined;
}

export type AnyDefinition = StepRecord | WorkflowRecord;

export function isLockedNode(value: unknown): value is LockedNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "node"
  );
}

/** A root node for a launch: no children, the launch input as literal. */
export function rootLock(
  definition: AnyDefinition,
  literal: Readonly<Record<string, unknown>>
): LockedNode {
  return {
    children: [],
    definition,
    kind: "node",
    literal,
    mode: "series",
    parsed: true,
  };
}
