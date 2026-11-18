import { createInternalizeOperator } from "./architectural-operator";
import { composeArchitecturalOperators } from "./operator-composition";
import type { OperatorComposition } from "./operator-composition-types";
import { decomposeArchitecturalOperator } from "./operator-decomposition";
import { planOperatorComposition } from "./operator-plan";
import type { OperatorExecutionPlan } from "./operator-plan-types";
import type { OperatorPlanningContext } from "./operator-planning-context";
import type { ArchitecturalOperator, OperatorContext } from "./operator-types";

export interface PlannedExecution {
  composition: OperatorComposition;
  operators: [ArchitecturalOperator];
  plan: OperatorExecutionPlan;
}

export function executionPlanFor(
  facts: OperatorContext,
  planning: OperatorPlanningContext,
  planId: string
): PlannedExecution {
  const operator = createInternalizeOperator(facts, planId);
  const composition = composeArchitecturalOperators(
    [operator],
    [decomposeArchitecturalOperator(operator, facts)],
    facts
  );
  return {
    composition,
    operators: [operator],
    plan: planOperatorComposition(composition, [operator], planning, facts),
  };
}
