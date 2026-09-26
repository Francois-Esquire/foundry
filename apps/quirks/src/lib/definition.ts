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
export type SetupFn<I> = (
  context: SetupContext<I>
) => LockedNode | Promise<LockedNode>;

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

/** What is left of `I` once children supply `K`; optional when nothing is. */
type Literal<I, C> = Omit<I, keyof C>;
type LiteralArgs<I, C> =
  Record<string, never> extends Literal<I, C>
    ? [input?: Literal<I, C>]
    : [input: Literal<I, C>];

export interface Lockable<I, O> {
  parallel<C extends Children>(
    children: C,
    ...input: LiteralArgs<I, C>
  ): LockedNode<O>;
  series<C extends Children>(
    children: C,
    ...input: LiteralArgs<I, C>
  ): LockedNode<O>;
  <C extends Children>(children: C, ...input: LiteralArgs<I, C>): LockedNode<O>;
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

/** The data of a step definition, without the lock forms. */
export interface StepRecord<I = never, O = unknown> extends Shared {
  readonly fn: StepFn<I, O>;
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

export interface StepDefinition<I = Record<string, never>, O = unknown>
  extends StepRecord<I, O>,
    Lockable<I, O> {}

export interface WorkflowDefinition<I = Record<string, never>, O = unknown>
  extends WorkflowRecord<I>,
    Lockable<I, O> {}

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
