import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { CallSite } from "./identity";
import { inputKeysOf } from "./schema";
import type { Context, SetupContext } from "./types";

/**
 * A definition has two phases. Build: the builder shapes it. Lock: invoking
 * it creates one node, with these children and this literal input. One
 * definition locks many times; each lock is its own node.
 */

type Children = Readonly<Record<string, LockedNode>>;

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

/**
 * What is left of the raw input `R` once children supply their keys;
 * optional when nothing is. `R` is the schema's input type, so defaulted
 * fields are optional and a transform's pre-image is what the literal takes.
 */
type Literal<R, C> = Omit<R, keyof C>;
type LiteralArgs<R, C> =
  Record<string, never> extends Literal<R, C>
    ? [input?: Literal<R, C>]
    : [input: Literal<R, C>];

/** A child node whose output must fit the parent's key; an untyped child passes. */
type ChildFor<T, N> =
  N extends LockedNode<infer O>
    ? unknown extends O
      ? N
      : O extends T
        ? N
        : never
    : never;

/**
 * The children a parent with raw input `R` accepts: every key declared, and
 * every child's output assignable to its key. A parent without a schema
 * (or with an index signature) accepts any children.
 */
type Accepts<R, C extends Children> = string extends keyof R
  ? C
  : {
      readonly [K in keyof C]: K extends keyof R ? ChildFor<R[K], C[K]> : never;
    };

export interface Lockable<R, O> {
  parallel<C extends Children>(
    children: C & Accepts<R, C>,
    ...input: LiteralArgs<R, C>
  ): LockedNode<O>;
  series<C extends Children>(
    children: C & Accepts<R, C>,
    ...input: LiteralArgs<R, C>
  ): LockedNode<O>;
  <C extends Children>(
    children: C & Accepts<R, C>,
    ...input: LiteralArgs<R, C>
  ): LockedNode<O>;
}

interface Shared {
  readonly description?: string;
  /** Set when `name` came from the config's `const`, not the call. */
  readonly inferred?: boolean;
  readonly input?: StandardSchemaV1;
  readonly name?: string;
  /** Where the config called the builder; only kept for nameless calls. */
  readonly site?: CallSite;
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

/**
 * `I` is the parsed input the body sees, `O` what the node produces for a
 * parent, `R` the raw input a lock's literal takes (the schema's input type).
 */
export interface StepDefinition<I = Record<string, never>, O = unknown, R = I>
  extends StepRecord<I, O>,
    Lockable<R, O> {}

export interface WorkflowDefinition<
  I = Record<string, never>,
  O = unknown,
  R = I,
> extends WorkflowRecord<I>,
    Lockable<R, O> {}

export function isLockedNode(value: unknown): value is LockedNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "node"
  );
}

function describe(definition: Shared): string {
  return definition.name ? `"${definition.name}"` : "an anonymous definition";
}

function lock(
  definition: AnyDefinition,
  mode: "series" | "parallel",
  children: Children,
  literal: Readonly<Record<string, unknown>> | undefined
): LockedNode {
  const pairs = Object.entries(children);
  for (const [key, child] of pairs) {
    if (!isLockedNode(child)) {
      throw new Error(
        `${describe(definition)}: child "${key}" is not a locked node; call the definition first`
      );
    }
  }
  const input = literal ?? {};
  const collision = pairs.find(([key]) => key in input);
  if (collision) {
    throw new Error(
      `${describe(definition)}: "${collision[0]}" is both a child and an input key`
    );
  }
  const declared = definition.input ? inputKeysOf(definition.input) : undefined;
  if (declared) {
    const unknown = pairs.find(([key]) => !declared.includes(key));
    if (unknown) {
      throw new Error(
        `${describe(definition)}: child "${unknown[0]}" is not an input key (declared: ${declared.join(", ")})`
      );
    }
  }
  return {
    children: pairs,
    definition,
    kind: "node",
    literal: input,
    mode,
  };
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

/** Attach the lock forms to a record, making it callable. */
export function lockable<D extends AnyDefinition>(
  fields: Omit<D, keyof Lockable<never, unknown>>
): D {
  const call = (children: Children, literal?: Record<string, unknown>) =>
    lock(definition, "series", children, literal);
  const definition = call as unknown as D;
  const members: Record<string, unknown> = {
    ...fields,
    // A function's own `name` is read-only; define it, and define it even
    // when absent so an anonymous definition never reports "call".
    name: (fields as { name?: string }).name,
    parallel: (children: Children, literal?: Record<string, unknown>) =>
      lock(definition, "parallel", children, literal),
    series: (children: Children, literal?: Record<string, unknown>) =>
      lock(definition, "series", children, literal),
  };
  for (const [key, value] of Object.entries(members)) {
    Object.defineProperty(call, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: false,
    });
  }
  return definition;
}
