import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { Context, SetupContext } from "./types";

/**
 * What the engine runs. A definition is a record: a body, its schemas, and
 * a name when it can be launched from outside. A locked node places one in
 * a tree, with these children and this literal input. Both are plain data;
 * how a host writes them is its own business.
 */

export type StepFn<I, O> = (context: Context<I>) => O | Promise<O>;
export type SetupFn<I, O = unknown> = (
  context: SetupContext<I>
) => LockedNode<O> | Promise<LockedNode<O>>;

export interface LockedNode<O = unknown> {
  /** Phantom: the node's output type. */
  readonly __output?: O;
  readonly children: readonly (readonly [string, LockedNode])[];
  /**
   * A workflow appears here only as what a trigger launches, a node with
   * no children; inside the tree a run executes, every node is a step.
   */
  readonly definition: AnyDefinition;
  readonly kind: "node";
  readonly literal: Readonly<Record<string, unknown>>;
  readonly mode: "series" | "parallel";
  /** Set on a launch root: the literal is already parsed input. */
  readonly parsed?: boolean;
}

export interface Shared {
  readonly description?: string;
  readonly input?: StandardSchemaV1;
  readonly name?: string;
  /**
   * How the author can name a nameless definition, in the host's words.
   * The engine appends it when a launch needs a name it does not have.
   */
  readonly nameHint?: string;
  /**
   * Where the host declared this definition, as a person would look for it
   * (a file and line). The engine only quotes it, in messages about the
   * definition such as a duplicate name.
   */
  readonly origin?: string;
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

/**
 * The data of a workflow definition: setup that returns the tree a run
 * executes. A tree known up front is a setup that returns it.
 */
export interface WorkflowRecord<I = never> extends Shared {
  readonly kind: "workflow";
  readonly setup: SetupFn<I>;
}

export type AnyDefinition = StepRecord | WorkflowRecord;

/** ` (origin)` for a message, or nothing when the host did not say. */
export function quoteOrigin(origin: string | undefined): string {
  return origin === undefined ? "" : ` (${origin})`;
}

/** A definition with a name: what a registry holds and an engine launches. */
export type NamedDefinition = AnyDefinition & { readonly name: string };

export function isNamed(
  definition: AnyDefinition
): definition is NamedDefinition {
  return definition.name !== undefined;
}

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
