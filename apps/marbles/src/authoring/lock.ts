import { enqueueDefinition, runDefinition } from "~/authoring/instances";
import { captureScope, trackLockedDeclaration } from "~/authoring/runtime";
import type {
  AnyDefinition,
  LockedNode,
  Shared,
  StepRecord,
  WorkflowRecord,
} from "~/lib/definition";
import { isLockedNode } from "~/lib/definition";
import { inputKeysOf } from "~/lib/schema";

type Children = Readonly<Record<string, LockedNode>>;

type Literal<R, C> = Omit<R, keyof C>;
type NoInput<R> = Record<string, never> extends R ? [] : [children: never];

type LiteralArgs<R, C> =
  Record<string, never> extends Literal<R, C>
    ? [input?: Literal<R, C>]
    : [input: Literal<R, C>];

type ChildFor<T, N> =
  N extends LockedNode<infer O>
    ? unknown extends O
      ? N
      : O extends T
        ? N
        : never
    : never;

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
  parallel(...none: NoInput<R>): LockedNode<O>;
  series<C extends Children>(
    children: C & Accepts<R, C>,
    ...input: LiteralArgs<R, C>
  ): LockedNode<O>;
  series(...none: NoInput<R>): LockedNode<O>;
  <C extends Children>(
    children: C & Accepts<R, C>,
    ...input: LiteralArgs<R, C>
  ): LockedNode<O>;
  (...none: NoInput<R>): LockedNode<O>;
}

type RunArgs<R> = Record<string, never> extends R ? [input?: R] : [input: R];

export interface EnqueueOptions {
  readonly key?: string;
}

export interface Enqueued<O> {
  readonly id: string;
  readonly result: Promise<O>;
}

type EnqueueArgs<R> =
  Record<string, never> extends R
    ? [input?: R, options?: EnqueueOptions]
    : [input: R, options?: EnqueueOptions];

export interface Runnable<R, O> {
  enqueue(...args: EnqueueArgs<R>): Promise<Enqueued<O>>;
  run(...input: RunArgs<R>): Promise<O>;
}

export interface StepDefinition<I = Record<string, never>, O = unknown, R = I>
  extends StepRecord<I, O>,
    Lockable<R, O>,
    Runnable<R, O> {}

export interface WorkflowDefinition<
  I = Record<string, never>,
  O = unknown,
  R = I,
> extends WorkflowRecord<I>,
    Lockable<R, O>,
    Runnable<R, O> {}

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
    if (definition.kind === "workflow" && key === "$workflow") {
      throw new Error(
        `${describe(definition)}: child "${key}" is reserved for nested workflows`
      );
    }
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
  trackLockedDeclaration(definition);
  return {
    children: pairs,
    definition,
    kind: "node",
    literal: input,
    mode,
  };
}

export function lockable<D extends AnyDefinition>(
  fields: Omit<
    D,
    keyof Lockable<never, unknown> | keyof Runnable<never, unknown>
  >
): D {
  const call = (children?: Children, literal?: Record<string, unknown>) =>
    lock(definition, "series", children ?? {}, literal);
  const definition = call as unknown as D;
  const members: Record<string, unknown> = {
    ...fields,
    name: (fields as { name?: string }).name,
    parallel: (children?: Children, literal?: Record<string, unknown>) =>
      lock(definition, "parallel", children ?? {}, literal),
    series: (children?: Children, literal?: Record<string, unknown>) =>
      lock(definition, "series", children ?? {}, literal),
  };
  for (const [key, value] of Object.entries(members)) {
    Object.defineProperty(call, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: false,
    });
  }
  const scope = captureScope();
  Object.defineProperties(call, {
    enqueue: {
      configurable: true,
      value: (input?: unknown, options?: EnqueueOptions) =>
        enqueueDefinition(definition, input ?? {}, scope, options),
    },
    run: {
      configurable: true,
      value: (input?: unknown) => runDefinition(definition, input ?? {}, scope),
    },
  });
  return definition;
}
