import type {
  FoldPackagePlan,
  InternalizeSymbolPlan,
  PlanBoundary,
  PlanIntelligence,
  PlanIntent,
  PlanScale,
  PlanSurface,
  ReductionPlan,
  SurfaceReport,
} from "./types";

// Plan intelligence: a deterministic description of a plan's real scale,
// surface, boundary impact, and architectural context. Pure composition over
// data the analysis already produced — no rescanning, no ts-morph, no
// thresholds, no labels, no scores. Reads only report.summary,
// report.dependencies, report.opportunities, and report.anchor (never
// report.plans, so attachment order cannot matter).

function ratioOrNull(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function foldScale(plan: FoldPackagePlan, report: SurfaceReport): PlanScale {
  const byKind = { config: 0, other: 0, source: 0, test: 0 };
  for (const file of plan.files) {
    byKind[file.kind] += 1;
  }
  return {
    files: { total: plan.files.length, ...byKind },
    imports: {
      moduleEdges: plan.boundaryUsage.moduleEdges,
      sites: plan.boundaryUsage.importSites,
    },
    symbols: {
      externallyUsed: report.summary.externallyUsedSymbols,
      moduleExported: report.summary.moduleExportedSymbols,
      packagePublic: report.summary.packagePublicSymbols,
      total: report.summary.totalSymbols,
    },
  };
}

function internalizeScale(plan: InternalizeSymbolPlan): PlanScale {
  const files = new Set(plan.publicRoutes.map((route) => route.file));
  return {
    files: {
      config: 0,
      other: 0,
      source: files.size,
      test: 0,
      total: files.size,
    },
    imports: { moduleEdges: 0, sites: 0 },
    symbols: {
      externallyUsed: 0,
      moduleExported: 1,
      packagePublic: 1,
      total: 1,
    },
  };
}

function surfaceFor(plan: ReductionPlan, report: SurfaceReport): PlanSurface {
  const {
    moduleExportedSymbols,
    packagePublicSymbols,
    externallyUsedSymbols,
    unusedExternalExports,
    moduleOnlyExports,
  } = report.summary;
  const base = {
    consumedSurfaceRatio: ratioOrNull(
      externallyUsedSymbols,
      packagePublicSymbols
    ),
    externallyUsedSymbols,
    moduleExportedSymbols,
    moduleOnlyExports,
    packagePublicSymbols,
    unusedExternalExports,
    unusedExternalSurfaceRatio: ratioOrNull(
      unusedExternalExports,
      packagePublicSymbols
    ),
  };
  if (plan.operation === "fold-package") {
    const references = plan.consumedSurface.reduce(
      (sum, usage) => sum + usage.references,
      0
    );
    return {
      ...base,
      potentiallyInternalizedSymbols: plan.potentiallyInternalized.length,
      referenceDensity: ratioOrNull(
        references,
        plan.boundaryUsage.consumedSymbols
      ),
    };
  }
  const unsupportedRoutes = plan.plannedChanges.filter(
    (change) => change.kind === "unsupported"
  ).length;
  return {
    ...base,
    potentiallyInternalizedSymbols: 1,
    publicRoutes: {
      supported: plan.publicRoutes.length - unsupportedRoutes,
      total: plan.publicRoutes.length,
      unsupported: unsupportedRoutes,
    },
  };
}

function boundaryFor(plan: ReductionPlan, report: SurfaceReport): PlanBoundary {
  const { dependencies } = report;
  const base = {
    consumerPackages: dependencies.consumerPackages,
    dependencyPackages: dependencies.dependencyPackages,
    incomingDependencyEdges: dependencies.incoming.length,
    outgoingDependencyEdges: dependencies.outgoing.length,
  };
  if (plan.operation === "fold-package") {
    return {
      ...base,
      flow: {
        cycle: plan.cautions.some(
          (caution) => caution.reason === "dependency-cycle"
        ),
        destinationToSource: plan.dependencyEdges.length > 0,
        sourceToDestination: dependencies.outgoing.some(
          (dependency) => dependency.package === plan.destination.package
        ),
      },
      importSitesCrossingBoundary: plan.boundaryUsage.importSites,
      moduleEdgesCrossingBoundary: plan.boundaryUsage.moduleEdges,
      packageBoundariesAffected: 1,
    };
  }
  return {
    ...base,
    importSitesCrossingBoundary: 0,
    moduleEdgesCrossingBoundary: 0,
    packageBoundariesAffected: 0,
  };
}

function intentFor(plan: ReductionPlan, report: SurfaceReport): PlanIntent {
  const reasons = new Set<string>();
  const opportunity = report.opportunities.find((entry) =>
    plan.operation === "fold-package"
      ? entry.operation === "fold-package" &&
        entry.subject.id === plan.source.package
      : entry.operation === "internalize-symbol" &&
        entry.subject.id === plan.subject.id
  );
  for (const caution of opportunity?.cautions ?? []) {
    reasons.add(caution.reason);
  }
  if (plan.operation === "fold-package") {
    for (const caution of plan.cautions) {
      reasons.add(caution.reason);
    }
  } else {
    for (const blocker of plan.blockers) {
      reasons.add(blocker.reason);
    }
  }
  return {
    anchored: report.anchor !== undefined,
    anchors:
      report.anchor === undefined
        ? []
        : [
            {
              target: report.anchor.target,
              ...(report.anchor.reason !== undefined && {
                reason: report.anchor.reason,
              }),
            },
          ],
    designedExports: reasons.has("designed-exports"),
    publishable: reasons.has("publishable"),
  };
}

/**
 * Compose the intelligence summary for one plan from the report it came from.
 * Deterministic and read-only; called during analysis and attached as
 * `plan.intelligence`, but usable standalone against any matching report.
 */
export function buildPlanIntelligence(
  plan: ReductionPlan,
  report: SurfaceReport
): PlanIntelligence {
  return {
    boundary: boundaryFor(plan, report),
    consequence:
      plan.operation === "fold-package"
        ? plan.predictedDelta
        : { certain: plan.predictedDelta, potential: {} },
    intent: intentFor(plan, report),
    scale:
      plan.operation === "fold-package"
        ? foldScale(plan, report)
        : internalizeScale(plan),
    surface: surfaceFor(plan, report),
  };
}
