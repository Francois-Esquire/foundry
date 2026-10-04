import type {
  AnyDefinition,
  LockedNode,
  Shared,
  StepRecord,
  WorkflowRecord,
} from "~/lib/definition";
import { isLockedNode } from "~/lib/definition";
import { inputKeysOf } from "~/lib/schema";

/**
 * A definition has two phases. Build: the builder shapes it. Lock: invoking
 * it creates one node, with these children and this literal input. One
 * definition locks many times; each lock is its own node.
 */

type Children = Readonly<Record<string, LockedNode>>;

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
