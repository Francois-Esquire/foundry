import { classifyFile } from "./churn";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type {
  BoundaryInteraction,
  BoundaryPressureSignal,
  DependencyGravity,
  PressureDimension,
  PressureEvidence,
  StructuralPressureKind,
  StructuralPressureReport,
  StructuralPressureSignal,
  SurfaceReport,
} from "./types";

/**
 * The report sections pressure composes. The architectural profile already
 * restates surface, consumption, gravity, complexity, and intent, so only
 * module gravity, boundary traffic, and per-function control flow are read
 * from their own sections.
 */
export type StructuralPressureSource = Pick<
  SurfaceReport,
  | "architecturalProfile"
  | "boundaryInteractions"
  | "dependencyGravity"
  | "localComplexity"
>;

type Gates = AnalysisConfig["structuralPressure"];

function dimensionsOf(evidence: PressureEvidence[]): PressureDimension[] {
  const seen: PressureDimension[] = [];
  for (const item of evidence) {
    if (!seen.includes(item.dimension)) {
      seen.push(item.dimension);
    }
  }
  return seen;
}

/**
 * Highest fan-in among source modules that are not aggregators. A barrel's
 * fan-in is the package surface and a test setup's fan-in is test
 * infrastructure; an internal center is what this gate looks for. Modules
 * without a role (graph-only sources) count as internal.
 */
function topInternalModuleByFanIn(source: StructuralPressureSource) {
  let top: DependencyGravity | undefined;
  for (const module of source.dependencyGravity.modules) {
    if (module.role?.kind === "aggregator") {
      continue;
    }
    if (classifyFile(module.node.id) !== "source") {
      continue;
    }
    if (top === undefined || module.direct.fanIn > top.direct.fanIn) {
      top = module;
    }
  }
  return top;
}

function branchHeavyFunctions(
  source: StructuralPressureSource,
  minControlFlow: number
): number {
  return source.localComplexity.functions.filter(
    (fn) => fn.metrics.decisions.controlFlow >= minControlFlow
  ).length;
}

function maxModuleDepth(source: StructuralPressureSource): number {
  let max = 0;
  for (const module of source.dependencyGravity.modules) {
    max = Math.max(max, module.depth.downstream, module.depth.upstream);
  }
  return max;
}

/**
 * Where incoming traffic lands, summed by declaring module across every
 * consumer, as a share of all incoming import sites. Same basis as V5.2
 * destination concentration — barrels contribute edges, not sites.
 */
function incomingDestination(source: StructuralPressureSource): {
  module: string;
  share: number;
} {
  const { incoming, summary } = source.boundaryInteractions;
  const sites = new Map<string, number>();
  for (const boundary of incoming) {
    for (const contribution of boundary.destinationModules) {
      sites.set(
        contribution.module,
        (sites.get(contribution.module) ?? 0) + contribution.importSites
      );
    }
  }
  let top: { module: string; share: number } = { module: "", share: 0 };
  const total = summary.incoming.importSites;
  for (const [module, count] of [...sites].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  )) {
    const share = total === 0 ? 0 : count / total;
    if (share > top.share) {
      top = { module, share };
    }
  }
  return top;
}

function packageSignals(
  source: StructuralPressureSource,
  gates: Gates
): StructuralPressureSignal[] {
  const { target } = source.architecturalProfile;
  const { gravity, surface, complexity, intent } = target;
  const { summary } = source.boundaryInteractions;
  const results: StructuralPressureSignal[] = [];
  const add = (
    kind: StructuralPressureKind,
    matched: boolean,
    evidence: PressureEvidence[]
  ) => {
    const dimensions = dimensionsOf(evidence);
    if (dimensions.length < 2) {
      throw new Error(`${kind} evidence spans a single dimension`);
    }
    if (matched) {
      results.push({
        dimensions,
        evidence,
        id: `${kind}:${target.node.id}`,
        intent,
        kind,
        scope: { id: target.node.id, type: "package" },
      });
    }
  };

  const primaryShare = surface.primaryConsumerShare;
  add(
    "surface-pressure",
    surface.packagePublicSymbols >= gates.surface.minPackagePublicSymbols &&
      surface.exportUtilization <= gates.surface.maxExportUtilization &&
      primaryShare !== undefined &&
      primaryShare >= gates.surface.minPrimaryConsumerShare,
    [
      {
        dimension: "surface",
        metric: "packagePublicSymbols",
        value: surface.packagePublicSymbols,
      },
      {
        dimension: "surface",
        metric: "externallyUsedSymbols",
        value: surface.externallyUsedSymbols,
      },
      {
        dimension: "surface",
        metric: "exportUtilization",
        value: surface.exportUtilization,
      },
      {
        dimension: "consumption",
        metric: "consumerPackages",
        value: surface.consumerPackages,
      },
      {
        dimension: "consumption",
        metric: "primaryConsumerShare",
        value: primaryShare ?? 0,
      },
      {
        dimension: "consumption",
        metric: "averageSymbolDistribution",
        value: surface.averageSymbolDistribution,
      },
    ]
  );

  add(
    "integration-pressure",
    gravity.fanOut >= gates.integration.minFanOut &&
      gravity.dependencyReach >= gates.integration.minDependencyReach &&
      summary.outgoing.importSites >= gates.integration.minOutgoingImportSites,
    [
      { dimension: "gravity", metric: "fanOut", value: gravity.fanOut },
      {
        dimension: "gravity",
        metric: "transitiveDependencies",
        value: gravity.transitiveDependencies,
      },
      {
        dimension: "gravity",
        metric: "dependencyReach",
        value: gravity.dependencyReach,
      },
      {
        dimension: "boundary",
        metric: "outgoingPackages",
        value: summary.outgoing.packages,
      },
      {
        dimension: "boundary",
        metric: "outgoingImportSites",
        value: summary.outgoing.importSites,
      },
      {
        dimension: "boundary",
        metric: "outgoingSymbols",
        value: summary.outgoing.symbols,
      },
    ]
  );

  const destination = incomingDestination(source);
  const incomingReferences = summary.incoming.references ?? 0;
  add(
    "centralization-pressure",
    gravity.fanIn >= gates.centralization.minFanIn &&
      incomingReferences >= gates.centralization.minIncomingReferences &&
      destination.share >= gates.centralization.minDestinationConcentration,
    [
      { dimension: "gravity", metric: "fanIn", value: gravity.fanIn },
      {
        dimension: "gravity",
        metric: "transitiveDependents",
        value: gravity.transitiveDependents,
      },
      {
        dimension: "gravity",
        metric: "dependentReach",
        value: gravity.dependentReach,
      },
      {
        dimension: "boundary",
        metric: "incomingPackages",
        value: summary.incoming.packages,
      },
      {
        dimension: "boundary",
        metric: "incomingImportSites",
        value: summary.incoming.importSites,
      },
      {
        dimension: "boundary",
        metric: "incomingReferences",
        value: incomingReferences,
      },
      {
        dimension: "boundary",
        metric: "destinationModule",
        value: destination.module,
      },
      {
        dimension: "boundary",
        metric: "destinationConcentration",
        value: destination.share,
      },
    ]
  );

  const packageDepth = Math.max(gravity.downstreamDepth, gravity.upstreamDepth);
  const moduleDepth = maxModuleDepth(source);
  const top = topInternalModuleByFanIn(source);
  const internal = gates.internalStructure;
  const branchHeavy = branchHeavyFunctions(
    source,
    internal.branchHeavyControlFlowDecisions
  );
  add(
    "internal-structure-pressure",
    moduleDepth - packageDepth >= internal.minDepthDelta &&
      top !== undefined &&
      top.direct.fanIn >= internal.minTopInternalModuleFanIn &&
      branchHeavy >= internal.minBranchHeavyFunctions,
    [
      { dimension: "gravity", metric: "packageDepth", value: packageDepth },
      { dimension: "gravity", metric: "maxModuleDepth", value: moduleDepth },
      {
        dimension: "gravity",
        metric: "depthDelta",
        value: moduleDepth - packageDepth,
      },
      {
        dimension: "gravity",
        metric: "topInternalModule",
        value: top?.node.id ?? "",
      },
      {
        dimension: "gravity",
        metric: "topInternalModuleFanIn",
        value: top?.direct.fanIn ?? 0,
      },
      {
        dimension: "gravity",
        metric: "topInternalModuleFanOut",
        value: top?.direct.fanOut ?? 0,
      },
      {
        dimension: "complexity",
        metric: "branchHeavyFunctions",
        value: branchHeavy,
      },
      {
        dimension: "complexity",
        metric: "controlFlowDecisionsP95",
        value: complexity.controlFlowDecisions.p95,
      },
      {
        dimension: "complexity",
        metric: "nestingMax",
        value: complexity.nesting.max,
      },
    ]
  );

  return results;
}

function boundarySignal(
  boundary: BoundaryInteraction,
  gates: Gates["boundary"]
): BoundaryPressureSignal | undefined {
  const references = boundary.symbols.references;
  const volume =
    boundary.importSites >= gates.minImportSites ||
    (references !== null && references >= gates.minReferences);
  const broad = volume && boundary.symbols.distinct >= gates.minSymbols;
  const concentrated =
    boundary.importSites >= gates.concentratedMinImportSites &&
    boundary.concentration.destinationModuleShare >= gates.concentratedShare;
  if (!(broad || concentrated)) {
    return undefined;
  }

  const topDestination = boundary.destinationModules.find(
    (contribution) => contribution.importSites > 0
  );
  const evidence: PressureEvidence[] = [
    {
      dimension: "boundary",
      metric: "importSites",
      value: boundary.importSites,
    },
    {
      dimension: "boundary",
      metric: "symbols",
      value: boundary.symbols.distinct,
    },
  ];
  if (references !== null) {
    evidence.push({
      dimension: "boundary",
      metric: "references",
      value: references,
    });
  }
  if (boundary.surfaceCoverage !== null) {
    evidence.push({
      dimension: "boundary",
      metric: "surfaceCoverage",
      value: boundary.surfaceCoverage,
    });
  }
  evidence.push({
    dimension: "boundary",
    metric: "destinationModules",
    value: boundary.breadth.destinationModules,
  });
  if (topDestination !== undefined) {
    evidence.push({
      dimension: "boundary",
      metric: "topDestinationModule",
      value: topDestination.module,
    });
  }
  evidence.push({
    dimension: "boundary",
    metric: "destinationConcentration",
    value: boundary.concentration.destinationModuleShare,
  });
  return {
    evidence,
    from: boundary.from,
    shape: broad && concentrated ? "mixed" : broad ? "broad" : "concentrated",
    to: boundary.to,
  };
}

/**
 * Compose pressure signals from sections that already exist on the report.
 * No scanning, no graph walks: every value is read or summed from V5.0–V5.2
 * output. Signals never become opportunities and carry no score.
 */
export function analyzeStructuralPressure(
  source: StructuralPressureSource,
  config: AnalysisConfig = ANALYSIS_CONFIG
): StructuralPressureReport {
  const gates = config.structuralPressure;
  const { incoming, outgoing, target } = source.boundaryInteractions;
  const boundaries: BoundaryPressureSignal[] = [];
  for (const boundary of [...incoming, ...outgoing]) {
    const signal = boundarySignal(boundary, gates.boundary);
    if (signal !== undefined) {
      boundaries.push(signal);
    }
  }
  return { boundaries, signals: packageSignals(source, gates), target };
}
