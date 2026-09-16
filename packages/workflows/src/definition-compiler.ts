import type {
  BranchPlan,
  DefinitionPlanNode,
  GroupPlan,
  StepPlacementPlan,
  WorkflowDefinitionPlan,
} from "./definition-plan";
import {
  definitionRuntimeOptions,
  materializeDefinition,
} from "./definition-plan";
import type { DefinitionBinding } from "./definitions";
import type { BaseContext } from "./executable";
import type { Step } from "./step";
import type { StepSpec } from "./step-types";

interface DefinitionExecutionContext {
  branch(
    predicate: (input: unknown) => boolean | Promise<boolean>,
    ifTrue: Step,
    ifFalse: Step,
    input: unknown,
    name?: string
  ): Promise<unknown>;
  parallel(
    specs: Record<string, { readonly step: Step; readonly input: unknown }>,
    name?: string
  ): Promise<unknown>;
  readonly path: readonly string[];
  race(
    specs: Record<string, { readonly step: Step; readonly input: unknown }>,
    name?: string
  ): Promise<unknown>;
  sequence(
    steps: readonly Step[],
    input: unknown,
    name?: string
  ): Promise<unknown>;
  readonly step: {
    step(child: Step): void;
    markSkipped(path: readonly string[]): Promise<void>;
  };
}

export function compileWorkflowDefinition<
  RuntimeWorkflow,
  I,
  O,
  X extends BaseContext = BaseContext,
>(
  plan: WorkflowDefinitionPlan<I, O, X>,
  input: I,
  binding: DefinitionBinding<X> | undefined,
  createRuntime: (spec: StepSpec<I, O, X>) => RuntimeWorkflow,
  nodeKey = plan.definitionKey
): RuntimeWorkflow {
  return createRuntime({
    input,
    name: nodeKey,
    ...definitionRuntimeOptions(binding),
    execute: async (workflowInput, context) => {
      const values: Record<string, unknown> = { input: workflowInput };
      for (const node of plan.steps) {
        values[node.nodeKey] = await executeNode(
          node,
          values,
          context,
          binding
        );
      }
      return plan.output(values);
    },
  });
}

async function executeNode(
  node: DefinitionPlanNode,
  values: Record<string, unknown>,
  context: DefinitionExecutionContext,
  binding: DefinitionBinding | undefined
): Promise<unknown> {
  if (node.kind === "step") {
    return executeStep(node, values, context, binding);
  }
  if (node.kind === "branch") {
    return executeBranch(node, values, context, binding);
  }
  return executeGroup(node, values, context, binding);
}

async function executeStep(
  node: StepPlacementPlan,
  values: Record<string, unknown>,
  context: DefinitionExecutionContext,
  binding: DefinitionBinding | undefined
): Promise<unknown> {
  const child = materializeDefinition(
    node.definition,
    node.input(values),
    binding,
    node.nodeKey
  );
  context.step.step(child);
  return child.run();
}

async function executeGroup(
  node: GroupPlan,
  values: Record<string, unknown>,
  context: DefinitionExecutionContext,
  binding: DefinitionBinding | undefined
): Promise<unknown> {
  const input = node.input(values);
  const children = node.children.map((child) =>
    materializeDefinition(child.definition, input, binding, child.nodeKey)
  );
  if (node.kind === "sequence") {
    return context.sequence(children, input, node.nodeKey);
  }
  const entries: Record<
    string,
    { readonly step: Step; readonly input: unknown }
  > = {};
  for (const [index, child] of node.children.entries()) {
    const step = children[index];
    if (step === undefined) {
      throw new Error("Definition group child missing");
    }
    entries[child.nodeKey] = { input, step };
  }
  return node.kind === "parallel"
    ? context.parallel(entries, node.nodeKey)
    : context.race(entries, node.nodeKey);
}

async function executeBranch(
  node: BranchPlan,
  values: Record<string, unknown>,
  context: DefinitionExecutionContext,
  binding: DefinitionBinding | undefined
): Promise<unknown> {
  const input = node.input(values);
  const ifTrue = materializeDefinition(
    node.ifTrue.definition,
    input,
    binding,
    node.ifTrue.nodeKey
  );
  const ifFalse = materializeDefinition(
    node.ifFalse.definition,
    input,
    binding,
    node.ifFalse.nodeKey
  );
  const chosen = await Promise.resolve(node.predicate(input));
  await context.step.markSkipped([
    ...context.path,
    node.nodeKey,
    chosen ? node.ifFalse.nodeKey : node.ifTrue.nodeKey,
  ]);
  return context.branch(() => chosen, ifTrue, ifFalse, input, node.nodeKey);
}
