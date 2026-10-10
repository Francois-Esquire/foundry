import { createInternalizeOperator } from "./architectural-operator";
import { composeArchitecturalOperators } from "./operator-composition";
import type { OperatorComposition } from "./operator-composition-types";
import { decomposeArchitecturalOperator } from "./operator-decomposition";
import { planOperatorComposition } from "./operator-plan";
import type { OperatorExecutionPlan } from "./operator-plan-types";
import type { OperatorPlanningContext } from "./operator-planning-context";
import type { ArchitecturalOperator, OperatorContext } from "./operator-types";

// The chain from a saved plan to the execution plan readiness judges: the
// saved internalize plan as an operator, decomposed, composed, and planned
// against the sources. Read-only; `authorizeMutationPlan` takes what it
// returns. Every step is the existing analysis, called in its usual order.

/** An execution plan with the composition and operators it was planned from. */
export interface PlannedExecution {
  composition: OperatorComposition;
  operators: [ArchitecturalOperator];
  plan: OperatorExecutionPlan;
}

/**
 * The execution plan for one saved internalize plan, by its id
 * (`plan:internalize-symbol:<path#name>`). `facts` must hold the package
 * report the plan comes from (`createOperatorContext(projection, reports)`).
 */
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
