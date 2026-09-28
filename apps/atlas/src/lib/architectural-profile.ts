import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type {
  ArchitecturalComplexityProfile,
  ArchitecturalGravityProfile,
  ArchitecturalIntentProfile,
  ArchitecturalProfileEvidence,
  ArchitecturalProfileReport,
  ArchitecturalProfileSignalResult,
  ArchitecturalSurfaceProfile,
  SurfaceReport,
} from "./types";

/**
 * The report sections the profile composes. Structural subset of
 * `SurfaceReport` so the builder runs against a full report or during
 * assembly, before the profile itself exists.
 */
export type ProfileSource = Pick<
  SurfaceReport,
  | "anchor"
  | "dependencies"
  | "dependencyGravity"
  | "localComplexity"
  | "opportunities"
  | "plans"
  | "summary"
>;

function gravityProfile(source: ProfileSource): ArchitecturalGravityProfile {
  const { target } = source.dependencyGravity;
  return {
    cycleMember: target.cycle.member,
    dependencyReach: target.reach.dependencies,
    dependentReach: target.reach.dependents,
    downstreamDepth: target.depth.downstream,
    fanIn: target.direct.fanIn,
    fanOut: target.direct.fanOut,
    transitiveDependencies: target.transitive.dependencies,
    transitiveDependents: target.transitive.dependents,
    upstreamDepth: target.depth.upstream,
  };
}

function surfaceProfile(source: ProfileSource): ArchitecturalSurfaceProfile {
  const { summary, dependencies } = source;
  const primaryShare = dependencies.primaryConsumer?.referenceShare;
  return {
    averageSymbolDistribution: dependencies.averageSymbolDistribution,
    consumerPackages: dependencies.consumerPackages,
    declaredSurfaceRatio: summary.declaredSurfaceRatio,
    exportUtilization: summary.exportUtilization,
    externallyUsedSymbols: summary.externallyUsedSymbols,
    externalSurfaceRatio: summary.externalSurfaceRatio,
    moduleOnlyExports: summary.moduleOnlyExports,
    packagePublicSymbols: summary.packagePublicSymbols,
    totalSymbols: summary.totalSymbols,
    unusedExternalExports: summary.unusedExternalExports,
    ...(primaryShare !== undefined && { primaryConsumerShare: primaryShare }),
  };
}

function complexityProfile(
  source: ProfileSource
): ArchitecturalComplexityProfile {
  const { summary } = source.localComplexity;
  return {
    controlFlowDecisions: summary.controlFlowDecisions.distribution,
    decisions: summary.decisions.distribution,
    functionsAnalyzed: summary.functionsAnalyzed,
    nesting: summary.nesting.distribution,
    parameters: {
      max: summary.parameters.distribution.max,
      p90: summary.parameters.distribution.p90,
    },
    statements: {
      max: summary.statements.distribution.max,
      p90: summary.statements.distribution.p90,
    },
  };
}

function intentProfile(source: ProfileSource): ArchitecturalIntentProfile {
  const reasons = new Set<string>();
  for (const opportunity of source.opportunities) {
    for (const caution of opportunity.cautions) {
      reasons.add(caution.reason);
    }
  }
  for (const plan of source.plans) {
    if (plan.operation === "fold-package") {
      for (const caution of plan.cautions) {
        reasons.add(caution.reason);
      }
    }
    for (const blocker of plan.blockers) {
      reasons.add(blocker.reason);
    }
  }
  return {
    anchored: source.anchor !== undefined,
    ...(source.anchor?.reason !== undefined && {
      anchorReason: source.anchor.reason,
    }),
    ...(reasons.has("publishable") && { publishable: true }),
    ...(reasons.has("designed-exports") && { designedExports: true }),
  };
}

function signalsFor(
  _source: ProfileSource,
  gravity: ArchitecturalGravityProfile,
  surface: ArchitecturalSurfaceProfile,
  config: AnalysisConfig
): ArchitecturalProfileSignalResult[] {
  const gates = config.architecturalProfiles;
  const results: ArchitecturalProfileSignalResult[] = [];
  const add = (
    signal: ArchitecturalProfileSignalResult["signal"],
    matched: boolean,
    evidence: ArchitecturalProfileEvidence[]
  ) => {
    if (matched) {
      results.push({ evidence, signal });
    }
  };

  add(
    "foundation-like",
    gravity.fanIn >= gates.foundationLike.minFanIn &&
      gravity.fanOut <= gates.foundationLike.maxFanOut &&
      gravity.dependentReach > gravity.dependencyReach,
    [
      { metric: "fanIn", value: gravity.fanIn },
      { metric: "fanOut", value: gravity.fanOut },
      { metric: "dependentReach", value: gravity.dependentReach },
      { metric: "dependencyReach", value: gravity.dependencyReach },
    ]
  );

  add(
    "integration-like",
    gravity.fanIn <= gates.integrationLike.maxFanIn &&
      gravity.fanOut >= gates.integrationLike.minFanOut &&
      gravity.dependencyReach > gravity.dependentReach,
    [
      { metric: "fanIn", value: gravity.fanIn },
      { metric: "fanOut", value: gravity.fanOut },
      { metric: "dependencyReach", value: gravity.dependencyReach },
      { metric: "dependentReach", value: gravity.dependentReach },
    ]
  );

  add(
    "shared-hub-like",
    gravity.fanIn >= gates.sharedHubLike.minFanIn &&
      surface.consumerPackages >= gates.sharedHubLike.minConsumers &&
      surface.averageSymbolDistribution >=
        gates.sharedHubLike.minAverageSymbolDistribution,
    [
      { metric: "fanIn", value: gravity.fanIn },
      { metric: "consumerPackages", value: surface.consumerPackages },
      {
        metric: "averageSymbolDistribution",
        value: surface.averageSymbolDistribution,
      },
    ]
  );

  add(
    "leaf-like",
    gravity.fanIn <= gates.leafLike.maxFanIn &&
      gravity.fanOut >= gates.leafLike.minFanOut &&
      gravity.fanOut <= gates.leafLike.maxFanOut,
    [
      { metric: "fanIn", value: gravity.fanIn },
      { metric: "fanOut", value: gravity.fanOut },
    ]
  );

  add(
    "surface-heavy",
    surface.packagePublicSymbols >=
      gates.surfaceHeavy.minPackagePublicSymbols &&
      surface.exportUtilization <= gates.surfaceHeavy.maxExportUtilization,
    [
      { metric: "packagePublicSymbols", value: surface.packagePublicSymbols },
      { metric: "externallyUsedSymbols", value: surface.externallyUsedSymbols },
      { metric: "exportUtilization", value: surface.exportUtilization },
    ]
  );

  const primaryShare = surface.primaryConsumerShare;
  add(
    "narrowly-consumed",
    surface.consumerPackages >= 1 &&
      primaryShare !== undefined &&
      primaryShare >= gates.narrowlyConsumed.minPrimaryConsumerShare,
    [
      { metric: "consumerPackages", value: surface.consumerPackages },
      { metric: "primaryConsumerShare", value: primaryShare ?? 0 },
    ]
  );

  add(
    "broadly-consumed",
    surface.consumerPackages >= gates.broadlyConsumed.minConsumers &&
      primaryShare !== undefined &&
      primaryShare < gates.broadlyConsumed.maxPrimaryConsumerShare,
    [
      { metric: "consumerPackages", value: surface.consumerPackages },
      { metric: "primaryConsumerShare", value: primaryShare ?? 0 },
      {
        metric: "averageSymbolDistribution",
        value: surface.averageSymbolDistribution,
      },
    ]
  );

  return results;
}

/**
 * Compose the architectural profile from an existing report's sections.
 * Pure composition — no scanning, no graph traversal beyond the already-
 * computed module depths, no score. Package level only; module profiles
 * are deferred until module-local complexity aggregation exists.
 */
export function buildArchitecturalProfile(
  report: ProfileSource,
  config: AnalysisConfig = ANALYSIS_CONFIG
): ArchitecturalProfileReport {
  const gravity = gravityProfile(report);
  const surface = surfaceProfile(report);
  return {
    target: {
      complexity: complexityProfile(report),
      gravity,
      intent: intentProfile(report),
      node: report.dependencyGravity.target.node,
      signals: signalsFor(report, gravity, surface, config),
      surface,
    },
  };
}
