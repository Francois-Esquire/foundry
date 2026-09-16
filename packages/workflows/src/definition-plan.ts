import {
  DefinitionAuthoringError,
  requireDefinitionKey,
  requireNodeKey,
} from "./definition-errors";
import type {
  DefinitionBinding,
  DefinitionContext,
  DefinitionDescriptor,
  DefinitionGraphBuilder,
  DefinitionNodeDescriptor,
  DefinitionSource,
} from "./definitions";
import type { BaseContext } from "./executable";
import type { Step } from "./step";
import type { StepContext } from "./step-types";
import type { Bail } from "./types";

/** Private executable source for the Task 01 leaf-definition compiler. */
export interface LeafDefinitionPlan<I, O, X extends BaseContext = BaseContext> {
  readonly definitionKey: string;
  readonly description?: string;
  readonly execute: (
    input: I,
    context: StepContext<I, O, X>
  ) =>
    | Promise<O | Bail<unknown>>
    | AsyncGenerator<unknown, O | Bail<unknown>, unknown>;
  readonly kind: "step";
  readonly name?: string;
}

export interface StepPlacementPlan {
  readonly definition: DefinitionSource;
  readonly descriptor: DefinitionDescriptor;
  readonly input: (values: Record<string, unknown>) => unknown;
  readonly kind: "step";
  readonly nodeKey: string;
}

export interface GroupPlan {
  readonly children: readonly StepPlacementPlan[];
  readonly input: (values: Record<string, unknown>) => unknown;
  readonly kind: "sequence" | "parallel" | "race";
  readonly nodeKey: string;
}

export interface BranchPlan {
  readonly ifFalse: StepPlacementPlan;
  readonly ifTrue: StepPlacementPlan;
  readonly input: (values: Record<string, unknown>) => unknown;
  readonly kind: "branch";
  readonly nodeKey: string;
  readonly predicate: (input: unknown) => boolean | Promise<boolean>;
}

export type DefinitionPlanNode = StepPlacementPlan | GroupPlan | BranchPlan;

export interface WorkflowDefinitionPlan<
  I,
  O,
  X extends BaseContext = BaseContext,
> {
  readonly __context?: X;
  readonly __input?: I;
  readonly definitionKey: string;
  readonly description?: string;
  readonly kind: "workflow";
  readonly name?: string;
  readonly output: (values: Record<string, unknown>) => O;
  readonly steps: readonly DefinitionPlanNode[];
}

export const definitionMaterializer = Symbol("definitionMaterializer");

interface DefinitionMaterializer {
  readonly [definitionMaterializer]: (
    input: unknown,
    binding: DefinitionBinding | undefined,
    nodeKey: string
  ) => unknown;
}

/**
 * Runtime-only context seed. The definition stays detached while a factory
 * invocation makes its durable RunExecutionContext available to every frame.
 */
export function definitionRuntimeSeed<X extends BaseContext>(
  binding: DefinitionBinding<X> | undefined
): Omit<X, "name"> | undefined {
  if (binding?.execution === undefined) {
    return binding?.seed;
  }
  return {
    ...binding.seed,
    execution: binding.execution,
  } as unknown as Omit<X, "name">;
}

/** Compose reusable and invocation context; invocation values win. */
export function definitionBindingFor<X extends BaseContext>(
  created: DefinitionContext<X> | undefined,
  invoked: DefinitionContext<X> | undefined
): DefinitionBinding<X> | undefined {
  if (created === undefined && invoked === undefined) {
    return undefined;
  }
  return {
    seed: {
      ...created,
      ...invoked,
    } as Omit<X, "name">,
  };
}

/** Omit an absent seed without repeating conditional spread ceremony. */
export function definitionRuntimeOptions<X extends BaseContext>(
  binding: DefinitionBinding<X> | undefined
): { readonly seed?: Omit<X, "name"> } {
  const seed = definitionRuntimeSeed(binding);
  return seed === undefined ? {} : { seed };
}

export function materializeDefinition(
  definition: DefinitionSource,
  input: unknown,
  binding: DefinitionBinding | undefined,
  nodeKey: string
): Step {
  const materializer = definition as unknown as Partial<DefinitionMaterializer>;
  if (materializer[definitionMaterializer] === undefined) {
    throw new Error("Definition must be a Step or Workflow definition.");
  }
  return materializer[definitionMaterializer](input, binding, nodeKey) as Step;
}

export function createLeafDefinitionPlan<
  I,
  O,
  X extends BaseContext = BaseContext,
>(input: LeafDefinitionPlan<I, O, X>): LeafDefinitionPlan<I, O, X> {
  return Object.freeze({
    ...input,
    definitionKey: requireDefinitionKey(input.definitionKey),
  });
}

/** Return a fresh, detached descriptor projection; never expose the plan. */
export function describeLeafDefinition(plan: {
  readonly definitionKey: string;
  readonly name?: string;
  readonly description?: string;
}): DefinitionDescriptor {
  const graph: DefinitionNodeDescriptor = Object.freeze({
    definitionKey: plan.definitionKey,
    kind: "step",
    nodeKey: plan.definitionKey,
    ...(plan.name === undefined ? {} : { name: plan.name }),
    ...(plan.description === undefined
      ? {}
      : { description: plan.description }),
  });
  return Object.freeze({
    definitionKey: plan.definitionKey,
    kind: "step",
    schemaVersion: 1,
    ...(plan.name === undefined ? {} : { name: plan.name }),
    ...(plan.description === undefined
      ? {}
      : { description: plan.description }),
    graph,
  });
}

export function createWorkflowDefinitionPlan<
  I,
  O,
  X extends BaseContext = BaseContext,
>(input: WorkflowDefinitionPlan<I, O, X>): WorkflowDefinitionPlan<I, O, X> {
  return Object.freeze({
    ...input,
    steps: Object.freeze(input.steps.map(freezePlanNode)),
  });
}

export function describeWorkflowDefinition(
  plan: Pick<
    WorkflowDefinitionPlan<unknown, unknown>,
    "definitionKey" | "name" | "description" | "steps"
  >
): DefinitionDescriptor {
  const graph: DefinitionNodeDescriptor = Object.freeze({
    definitionKey: plan.definitionKey,
    kind: "workflow",
    nodeKey: plan.definitionKey,
    ...(plan.name === undefined ? {} : { name: plan.name }),
    ...(plan.description === undefined
      ? {}
      : { description: plan.description }),
    children: Object.freeze(plan.steps.map(describePlanNode)),
  });
  return Object.freeze({
    definitionKey: plan.definitionKey,
    kind: "workflow",
    schemaVersion: 1,
    ...(plan.name === undefined ? {} : { name: plan.name }),
    ...(plan.description === undefined
      ? {}
      : { description: plan.description }),
    graph,
  });
}

function describePlanNode(node: DefinitionPlanNode): DefinitionNodeDescriptor {
  if (node.kind === "step") {
    return detachedNode(node.descriptor.graph, node.nodeKey);
  }
  if (node.kind === "branch") {
    return Object.freeze({
      children: Object.freeze([
        detachedNode(node.ifTrue.descriptor.graph, "ifTrue"),
        detachedNode(node.ifFalse.descriptor.graph, "ifFalse"),
      ]),
      kind: "branch",
      nodeKey: node.nodeKey,
    });
  }
  return Object.freeze({
    children: Object.freeze(
      node.children.map((child) =>
        detachedNode(child.descriptor.graph, child.nodeKey)
      )
    ),
    kind: node.kind,
    nodeKey: node.nodeKey,
  });
}

function freezePlanNode(node: DefinitionPlanNode): DefinitionPlanNode {
  if (node.kind === "step") {
    return Object.freeze({ ...node });
  }
  if (node.kind === "branch") {
    return Object.freeze({
      ...node,
      ifFalse: Object.freeze({ ...node.ifFalse }),
      ifTrue: Object.freeze({ ...node.ifTrue }),
    });
  }
  return Object.freeze({
    ...node,
    children: Object.freeze(
      node.children.map((child) => Object.freeze({ ...child }))
    ),
  });
}

/** Clone graph data only; executable plan data never crosses this boundary. */
function detachedNode(
  node: DefinitionNodeDescriptor,
  nodeKey = node.nodeKey
): DefinitionNodeDescriptor {
  return Object.freeze({
    ...node,
    nodeKey,
    ...(node.children === undefined
      ? {}
      : {
          children: Object.freeze(
            node.children.map((child) => detachedNode(child))
          ),
        }),
  });
}

export class WorkflowPlanBuilder<I, O, X extends BaseContext = BaseContext>
  implements DefinitionGraphBuilder<I, O, Record<never, never>, X>
{
  readonly #owner: string;
  readonly #steps: DefinitionPlanNode[] = [];
  #output: ((values: Record<string, unknown>) => O) | undefined;

  constructor(owner = "<unknown>") {
    this.#owner = owner;
  }

  step<Key extends string, ChildInput, ChildOutput>(
    nodeKey: Key,
    definition: DefinitionSource<ChildInput, ChildOutput, X>,
    input?: (values: { readonly input: I }) => ChildInput
  ): DefinitionGraphBuilder<I, O, Record<Key, ChildOutput>, X>;
  step<ChildInput, ChildOutput>(
    definition: DefinitionSource<ChildInput, ChildOutput, X>,
    input?: (values: { readonly input: I }) => ChildInput
  ): DefinitionGraphBuilder<I, O, Record<string, ChildOutput>, X>;
  step<Key extends string, ChildInput, ChildOutput>(
    nodeKeyOrDefinition: Key | DefinitionSource<ChildInput, ChildOutput, X>,
    definitionOrInput?:
      | DefinitionSource<ChildInput, ChildOutput, X>
      | ((values: { readonly input: I }) => ChildInput),
    maybeInput?: (values: { readonly input: I }) => ChildInput
  ): DefinitionGraphBuilder<I, O, Record<Key, ChildOutput>, X> {
    const definition =
      typeof nodeKeyOrDefinition === "string"
        ? (definitionOrInput as DefinitionSource<ChildInput, ChildOutput, X>)
        : nodeKeyOrDefinition;
    const descriptor = definition.definition;
    const key = requireNodeKey(
      this.#owner,
      typeof nodeKeyOrDefinition === "string"
        ? nodeKeyOrDefinition
        : descriptor.definitionKey
    );
    const input =
      typeof nodeKeyOrDefinition === "string"
        ? maybeInput
        : (definitionOrInput as
            | ((values: { readonly input: I }) => ChildInput)
            | undefined);
    if (this.#steps.some((step) => step.nodeKey === key)) {
      throw new DefinitionAuthoringError(
        "duplicate-node-key",
        this.#owner,
        [key],
        "sibling nodeKey is already declared"
      );
    }
    this.#steps.push({
      definition,
      descriptor,
      input:
        input === undefined
          ? (values) => values.input
          : (input as (values: Record<string, unknown>) => unknown),
      kind: "step",
      nodeKey: key,
    });
    return this as unknown as DefinitionGraphBuilder<
      I,
      O,
      Record<Key, ChildOutput>,
      X
    >;
  }

  sequence(
    nodeKey: string,
    children: readonly DefinitionSource[],
    input?: (values: { readonly input: I }) => unknown
  ): DefinitionGraphBuilder<I, O, Record<string, unknown>, X> {
    const keys = new Set<string>();
    this.#steps.push({
      children: children.map((child) => {
        const key = requireNodeKey(this.#owner, child.definition.definitionKey);
        if (keys.has(key)) {
          throw new DefinitionAuthoringError(
            "duplicate-node-key",
            this.#owner,
            [key],
            "sibling nodeKey is already declared"
          );
        }
        keys.add(key);
        return this.#child(key, child);
      }),
      input:
        input === undefined
          ? (values: Record<string, unknown>) => values.input
          : (input as (values: Record<string, unknown>) => unknown),
      kind: "sequence",
      nodeKey: this.#uniqueKey(nodeKey),
    });
    return this;
  }

  parallel(
    nodeKey: string,
    children: Readonly<Record<string, DefinitionSource>>,
    input?: (values: { readonly input: I }) => unknown
  ): DefinitionGraphBuilder<I, O, Record<string, unknown>, X> {
    return this.#group("parallel", nodeKey, children, input);
  }

  race(
    nodeKey: string,
    children: Readonly<Record<string, DefinitionSource>>,
    input?: (values: { readonly input: I }) => unknown
  ): DefinitionGraphBuilder<I, O, Record<string, unknown>, X> {
    return this.#group("race", nodeKey, children, input);
  }

  branch(
    nodeKey: string,
    predicate: (input: unknown) => boolean | Promise<boolean>,
    arms: {
      readonly ifTrue: DefinitionSource;
      readonly ifFalse: DefinitionSource;
    },
    input?: (values: { readonly input: I }) => unknown
  ): DefinitionGraphBuilder<I, O, Record<string, unknown>, X> {
    this.#steps.push({
      ifFalse: this.#child("ifFalse", arms.ifFalse),
      ifTrue: this.#child("ifTrue", arms.ifTrue),
      input:
        input === undefined
          ? (values: Record<string, unknown>) => values.input
          : (input as (values: Record<string, unknown>) => unknown),
      kind: "branch",
      nodeKey: this.#uniqueKey(nodeKey),
      predicate,
    });
    return this;
  }

  output(transform: (values: { readonly input: I }) => O): void {
    if (this.#output) {
      throw new DefinitionAuthoringError(
        "duplicate-output",
        this.#owner,
        [],
        "exactly one output may be declared"
      );
    }
    this.#output = transform as (values: Record<string, unknown>) => O;
  }

  build(args: {
    readonly definitionKey: string;
    readonly name?: string;
    readonly description?: string;
  }): WorkflowDefinitionPlan<I, O, X> {
    if (!this.#output) {
      throw new DefinitionAuthoringError(
        "missing-output",
        args.definitionKey,
        [],
        "exactly one output is required"
      );
    }
    return createWorkflowDefinitionPlan({
      kind: "workflow",
      ...args,
      definitionKey: requireDefinitionKey(args.definitionKey),
      output: this.#output,
      steps: this.#steps,
    });
  }

  #group(
    kind: "parallel" | "race",
    nodeKey: string,
    children: Readonly<Record<string, DefinitionSource>>,
    input?: (values: { readonly input: I }) => unknown
  ): DefinitionGraphBuilder<I, O, Record<string, unknown>, X> {
    const entries = Object.entries(children);
    if (kind === "race" && entries.length === 0) {
      throw new DefinitionAuthoringError(
        "invalid-composition",
        this.#owner,
        [nodeKey],
        "race requires at least one child"
      );
    }
    this.#steps.push({
      children: entries.map(([key, child]) => this.#child(key, child)),
      input:
        input === undefined
          ? (values: Record<string, unknown>) => values.input
          : (input as (values: Record<string, unknown>) => unknown),
      kind,
      nodeKey: this.#uniqueKey(nodeKey),
    });
    return this;
  }

  #child(nodeKey: string, definition: DefinitionSource): StepPlacementPlan {
    return {
      definition,
      descriptor: definition.definition,
      input: (values) => values.input,
      kind: "step",
      nodeKey: requireNodeKey(this.#owner, nodeKey),
    };
  }

  #uniqueKey(nodeKey: string): string {
    const key = requireNodeKey(this.#owner, nodeKey);
    if (this.#steps.some((node) => node.nodeKey === key)) {
      throw new DefinitionAuthoringError(
        "duplicate-node-key",
        this.#owner,
        [key],
        "sibling nodeKey is already declared"
      );
    }
    return key;
  }
}
