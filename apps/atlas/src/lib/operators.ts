import type { ApplyOptions } from "./apply";
import { applyReductionPlan } from "./apply";
import { buildFoldPackagePlan } from "./fold-plan";
import { buildInternalizationPlan } from "./plan";
import type {
  MutationResult,
  OperatorCapabilities,
  OperatorSummary,
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
  apply: applyReductionPlan,
  capabilities: { apply: true, plan: true, validate: true, verify: true },
  id: "internalize-export",
  opportunityOperation: "internalize-symbol",
  plan: buildInternalizationPlan,
  validate: validateReductionPlan,
};

const foldPackageOperator: StructuralOperator = {
  capabilities: { apply: false, plan: true, validate: true, verify: false },
  id: "fold-package",
  opportunityOperation: "fold-package",
  plan: buildFoldPackagePlan,
  validate: validateReductionPlan,
};

const OPERATORS = new Map<string, StructuralOperator>([
  ["internalize-export", internalizeExportOperator],
  ["fold-package", foldPackageOperator],
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

/** Per-operator lifecycle state for one report; computed during analysis. */
export function operatorSummaries(
  opportunities: ReductionOpportunity[],
  plans: ReductionPlan[]
): OperatorSummary[] {
  return listOperators().map((operator) => {
    const own = plans.filter((plan) =>
      operator.opportunityOperation === "internalize-symbol"
        ? plan.operation === "internalize-symbol"
        : plan.operation === "fold-package"
    );
    return {
      capabilities: operator.capabilities,
      id: operator.id,
      opportunities: opportunities.filter(
        (opportunity) => opportunity.operation === operator.opportunityOperation
      ).length,
      plans: {
        blocked: own.filter((plan) => plan.status === "blocked").length,
        ready: own.filter((plan) => plan.status === "ready").length,
        unsupported: own.filter((plan) => plan.status === "unsupported").length,
      },
      unsupportedReasons: unsupportedReasons(own),
    };
  });
}

/** Each unsupported plan counts each of its distinct blocker reasons once. */
function unsupportedReasons(plans: ReductionPlan[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const plan of plans) {
    if (plan.status !== "unsupported") {
      continue;
    }
    for (const reason of new Set(
      plan.blockers.map((blocker) => blocker.reason)
    )) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  return Object.fromEntries(
    [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    )
  );
}
