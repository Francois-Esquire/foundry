import type {
  OperatorCapabilities,
  OperatorSummary,
  ReductionOpportunity,
  ReductionPlan,
} from "./types";

export const OPERATOR_DESCRIPTIONS = {
  fold: {
    capabilities: { apply: false, plan: true, validate: true, verify: false },
    id: "fold-package",
    opportunityOperation: "fold-package",
  },
  internalize: {
    capabilities: { apply: true, plan: true, validate: true, verify: true },
    id: "internalize-export",
    opportunityOperation: "internalize-symbol",
  },
} satisfies Record<
  string,
  {
    id: "internalize-export" | "fold-package";
    opportunityOperation: ReductionOpportunity["operation"];
    capabilities: OperatorCapabilities;
  }
>;

/** Per-operator lifecycle state for one report; computed during analysis. */
export function operatorSummaries(
  opportunities: ReductionOpportunity[],
  plans: ReductionPlan[]
): OperatorSummary[] {
  return [OPERATOR_DESCRIPTIONS.internalize, OPERATOR_DESCRIPTIONS.fold].map(
    (operator) => {
      const own = plans.filter(
        (plan) => plan.operation === operator.opportunityOperation
      );
      return {
        capabilities: operator.capabilities,
        id: operator.id,
        opportunities: opportunities.filter(
          (opportunity) =>
            opportunity.operation === operator.opportunityOperation
        ).length,
        plans: {
          blocked: own.filter((plan) => plan.status === "blocked").length,
          ready: own.filter((plan) => plan.status === "ready").length,
          unsupported: own.filter((plan) => plan.status === "unsupported")
            .length,
        },
        unsupportedReasons: unsupportedReasons(own),
      };
    }
  );
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
