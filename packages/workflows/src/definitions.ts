import type { BaseContext } from "./executable";
import type { RunExecutionContext } from "./orchestrator";

export { DefinitionAuthoringError } from "./definition-errors";

/** JSON-safe presentation of one code-defined workflow graph. */
export interface DefinitionDescriptor {
  readonly definitionKey: string;
  readonly description?: string;
  readonly graph: DefinitionBehaviorNodeDescriptor;
  readonly kind: "step" | "workflow";
  readonly name?: string;
  readonly schemaVersion: 1;
}

/** A placement of reusable behavior; only these nodes have behavior identity. */
export interface DefinitionBehaviorNodeDescriptor {
  readonly children?: readonly DefinitionNodeDescriptor[];
  readonly definitionKey: string;
  readonly description?: string;
  readonly kind: "step" | "workflow";
  readonly name?: string;
  readonly nodeKey: string;
}

/** A synthetic control-flow node, identified only by its local placement. */
export interface DefinitionCompositionNodeDescriptor {
  readonly children?: readonly DefinitionNodeDescriptor[];
  readonly kind: "sequence" | "parallel" | "race" | "branch";
  readonly nodeKey: string;
}

export type DefinitionNodeDescriptor =
  | DefinitionBehaviorNodeDescriptor
  | DefinitionCompositionNodeDescriptor;

/** Common structural contract shared by public Step and Workflow definitions. */
export interface DefinitionSource<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> {
  __definitionContext?(context: X): void;
  /** Type-only marker methods; definitions never allocate these at runtime. */
  __definitionInput?(input: I): void;
  __definitionOutput?(): O;
  readonly definition: DefinitionDescriptor;
}

type DefinitionValues<I, Values extends object> = {
  readonly input: I;
} & Values;

/** Read-only builder surface public Workflow subclasses receive. */
export interface DefinitionGraphBuilder<
  I,
  O,
  Values extends object = Record<never, never>,
  X extends BaseContext = BaseContext,
> {
  branch(
    nodeKey: string,
    predicate: (input: unknown) => boolean | Promise<boolean>,
    arms: {
      readonly ifTrue: DefinitionSource;
      readonly ifFalse: DefinitionSource;
    },
    input?: (values: DefinitionValues<I, Values>) => unknown
  ): DefinitionGraphBuilder<I, O, Values & Record<string, unknown>, X>;
  output(transform: (values: DefinitionValues<I, Values>) => O): void;
  parallel(
    nodeKey: string,
    children: Readonly<Record<string, DefinitionSource>>,
    input?: (values: DefinitionValues<I, Values>) => unknown
  ): DefinitionGraphBuilder<I, O, Values & Record<string, unknown>, X>;
  race(
    nodeKey: string,
    children: Readonly<Record<string, DefinitionSource>>,
    input?: (values: DefinitionValues<I, Values>) => unknown
  ): DefinitionGraphBuilder<I, O, Values & Record<string, unknown>, X>;
  sequence(
    nodeKey: string,
    children: readonly DefinitionSource[],
    input?: (values: DefinitionValues<I, Values>) => unknown
  ): DefinitionGraphBuilder<I, O, Values & Record<string, unknown>, X>;
  step<Key extends string, ChildInput, ChildOutput>(
    nodeKey: Key,
    child: DefinitionSource<ChildInput, ChildOutput, X>,
    input?: (values: DefinitionValues<I, Values>) => ChildInput
  ): DefinitionGraphBuilder<I, O, Values & Record<Key, ChildOutput>, X>;
  step<ChildInput, ChildOutput>(
    child: DefinitionSource<ChildInput, ChildOutput, X>,
    input?: (values: DefinitionValues<I, Values>) => ChildInput
  ): DefinitionGraphBuilder<I, O, Values & Record<string, ChildOutput>, X>;
}

/** Context supplied while materializing a definition into one runtime tree. */
export interface DefinitionBinding<X extends BaseContext = BaseContext> {
  readonly execution?: RunExecutionContext;
  readonly seed?: Omit<X, "name">;
}

/**
 * Public context for a reusable definition invocation. Durable execution is
 * host-owned and injected only by the Orchestrator factory.
 */
export type DefinitionContext<X extends BaseContext = BaseContext> = Partial<
  Omit<X, "name" | "execution">
>;
