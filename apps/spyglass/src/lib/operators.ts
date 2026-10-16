import type { ApplyOptions } from "./apply";
import { applyReductionPlan } from "./apply";
import { buildFoldPackagePlan } from "./fold-plan";
import { OPERATOR_DESCRIPTIONS } from "./operator-summaries";
import { buildInternalizationPlan } from "./plan";
import type {
  MutationResult,
  OperatorCapabilities,
  PlanValidation,
  ReductionOpportunity,
  ReductionPlan,
  SurfaceReport,
} from "./types";
import { validateReductionPlan } from "./validate";

// One convention for structural operations: detect (V2 policy, not here) →
// plan → validate → apply → verify. Operators implement only the stages they
// support; unsupported stages are explicit capabilities, never silent no-ops.
// internalize-export operates on internalize-symbol opportunities/plans; the
// operator is named for the transformation it performs, the opportunity for
// the structural finding.

type OperatorId = "internalize-export" | "fold-package";

export interface StructuralOperator {
  apply?: (
    plan: ReductionPlan,
    options?: ApplyOptions
  ) => Promise<MutationResult>;
  capabilities: OperatorCapabilities;
  id: OperatorId;
  /** The opportunity operation this operator's plans come from. */
  opportunityOperation: "internalize-symbol" | "fold-package";
  plan(report: SurfaceReport, opportunity: ReductionOpportunity): ReductionPlan;
  validate(plan: ReductionPlan, report: SurfaceReport): PlanValidation;
}

const internalizeExportOperator: StructuralOperator = {
  ...OPERATOR_DESCRIPTIONS.internalize,
  apply: applyReductionPlan,
  plan: buildInternalizationPlan,
  validate: validateReductionPlan,
};

const foldPackageOperator: StructuralOperator = {
  ...OPERATOR_DESCRIPTIONS.fold,
  plan: buildFoldPackagePlan,
  validate: validateReductionPlan,
};

const OPERATORS = new Map<string, StructuralOperator>([
  [internalizeExportOperator.id, internalizeExportOperator],
  [foldPackageOperator.id, foldPackageOperator],
]);

export function getOperator(id: string): StructuralOperator {
  const operator = OPERATORS.get(id);
  if (operator === undefined) {
    throw new Error(
      `Unknown operator "${id}" — known operators: ${[...OPERATORS.keys()].join(", ")}.`
    );
  }
  return operator;
}

export function listOperators(): StructuralOperator[] {
  return [...OPERATORS.values()];
}
