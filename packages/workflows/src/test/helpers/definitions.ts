import { materializeDefinition } from "../../definition/plan";
import type { DefinitionBinding } from "../../definitions";
import type { BaseContext } from "../../slices/executable";
import type { Step } from "../../step";
import { Workflow } from "../../workflow";

export function materializeStep<I, O, X extends BaseContext>(
  definition: Step<I, O, X>,
  input: I,
  binding?: DefinitionBinding<X>
): Step<I, O, X> {
  return materializeDefinition(
    definition,
    input,
    binding,
    definition.definition.definitionKey
  ) as unknown as Step<I, O, X>;
}

export function materializeWorkflow<I, O, X extends BaseContext>(
  definition: Workflow<I, O, X>,
  input: I,
  binding?: DefinitionBinding<X>
): Workflow<I, O, X> {
  const root = materializeDefinition(
    definition,
    input,
    binding,
    definition.definition.definitionKey
  ) as unknown as Step<I, O, X>;
  return Workflow.attach(root, input);
}
