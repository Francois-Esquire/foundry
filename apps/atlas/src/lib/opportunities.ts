import type { Boundary } from "./boundary";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type {
  FailedGate,
  IneligibleOperation,
  ReductionEvidence,
  ReductionOperation,
  ReductionOpportunity,
  SurfaceDependencies,
  SurfaceSymbol,
} from "./types";

// Eligibility gates are hard conditions — weighted evidence never
// compensates for a failed gate. Cautions warn without changing confidence:
// a cycle already zeroes the one-way term and the concentration terms are
// computed from the raw shares. All tuning lives in config.ts.

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function boundaryName(boundary: Boundary): string {
  return boundary.packageName ?? boundary.relPath;
}

function internalizeOpportunities(
  symbols: SurfaceSymbol[]
): ReductionOpportunity[] {
  return symbols
    .filter(
      (symbol) =>
        symbol.packagePublic &&
        symbol.externalReferences + symbol.externalImportSites === 0
    )
    .map((symbol) => ({
      cautions: [],
      estimatedReduction: [{ metric: "publicExports", value: 1 }],
      evidence: [
        { metric: "packagePublic", significance: "strong", value: true },
        { metric: "externalReferences", significance: "strong", value: 0 },
        { metric: "externalConsumers", significance: "strong", value: 0 },
      ] satisfies ReductionEvidence[],
      evidenceConfidence: 1,
      id: `internalize-symbol:${symbol.id}`,
      operation: "internalize-symbol" as const,
      subject: { id: symbol.id, name: symbol.name, type: "symbol" as const },
      summary: `${symbol.name} is an unused external export — no external references or consumers; it could leave the public surface.`,
    }));
}

function foldGates(
  dependencies: SurfaceDependencies,
  config: AnalysisConfig
): FailedGate[] {
  const { requiredConsumers } = config.opportunities.foldPackage.gates;
  const failed: FailedGate[] = [];
  if (dependencies.consumerPackages !== requiredConsumers) {
    failed.push({
      actual: dependencies.consumerPackages,
      expected: requiredConsumers,
      gate: "single-consumer",
    });
  }
  return failed;
}

function foldOpportunity(
  boundary: Boundary,
  symbols: SurfaceSymbol[],
  dependencies: SurfaceDependencies,
  config: AnalysisConfig
): ReductionOpportunity | undefined {
  const [primary] = dependencies.incoming;
  if (primary === undefined) {
    return undefined;
  }

  const oneWay = !dependencies.outgoing.some(
    (dependency) => dependency.package === primary.package
  );
  const { weights, narrowDistributionCeiling } =
    config.opportunities.foldPackage.evidence;
  const narrowness = clamp01(
    (narrowDistributionCeiling - dependencies.averageSymbolDistribution) /
      (narrowDistributionCeiling - 1)
  );
  const evidenceConfidence =
    weights.singleConsumer +
    weights.referenceConcentration * primary.referenceShare +
    weights.surfaceConcentration * primary.surfaceShare +
    weights.narrowDistribution * narrowness +
    (oneWay ? weights.oneWayDependency : 0);

  const name = boundaryName(boundary);
  const strongShare = (share: number) =>
    share >= config.dependency.concentration.highShare
      ? "strong"
      : "supporting";
  const evidence: ReductionEvidence[] = [
    { metric: "consumerPackages", significance: "strong", value: 1 },
    {
      metric: "referenceConcentration",
      significance: strongShare(primary.referenceShare),
      value: primary.referenceShare,
    },
    {
      metric: "surfaceConcentration",
      significance: strongShare(primary.surfaceShare),
      value: primary.surfaceShare,
    },
    {
      metric: "averageSymbolDistribution",
      significance: "supporting",
      value: dependencies.averageSymbolDistribution,
    },
    { metric: "oneWayDependency", significance: "supporting", value: oneWay },
  ];

  const cautions: ReductionOpportunity["cautions"] = [];
  if (!oneWay) {
    cautions.push({
      detail: `${name} and ${primary.package} depend on each other.`,
      reason: "dependency-cycle",
    });
  }
  if (boundary.explicitlyPublishable) {
    cautions.push({
      detail: 'Package appears independently publishable ("private": false).',
      reason: "publishable",
    });
  }
  if (boundary.exportSubpaths !== null && boundary.exportSubpaths.size > 1) {
    cautions.push({
      detail: `Package declares ${boundary.exportSubpaths.size} exports subpaths, suggesting an intentionally designed boundary.`,
      reason: "designed-exports",
    });
  }

  const exported = symbols.filter((symbol) => symbol.packagePublic).length;
  return {
    cautions,
    estimatedReduction: [
      { metric: "packageBoundaries", value: 1 },
      { metric: "potentiallyInternalizedExports", value: exported },
      { metric: "dependencyEdges", value: 1 },
    ],
    evidence,
    evidenceConfidence,
    id: `fold-package:${name}`,
    operation: "fold-package",
    subject: { id: name, name, type: "package" },
    summary: `${name} currently behaves primarily as an internal subsystem of ${primary.package}; consider folding it in while preserving internal module boundaries.`,
    target: {
      id: primary.package,
      name: primary.package,
      type: "package",
    },
  };
}

function preserveGates(
  dependencies: SurfaceDependencies,
  config: AnalysisConfig
): FailedGate[] {
  const failed: FailedGate[] = [];
  const { gates } = config.opportunities.preserveSharedBoundary;
  if (dependencies.consumerPackages < gates.minConsumers) {
    failed.push({
      actual: dependencies.consumerPackages,
      expected: gates.minConsumers,
      gate: "minimum-consumers",
    });
  }
  const primary = dependencies.primaryConsumer;
  if (
    primary !== undefined &&
    primary.referenceShare >= gates.maxPrimaryReferenceShare
  ) {
    failed.push({
      actual: primary.referenceShare,
      expected: `< ${gates.maxPrimaryReferenceShare}`,
      gate: "primary-reference-share",
    });
  }
  return failed;
}

function preserveOpportunity(
  boundary: Boundary,
  dependencies: SurfaceDependencies,
  config: AnalysisConfig
): ReductionOpportunity | undefined {
  const { incoming } = dependencies;
  const [primary] = incoming;
  if (primary === undefined) {
    return undefined;
  }

  const { weights, broadDistributionCeiling } =
    config.opportunities.preserveSharedBoundary.evidence;
  const evidenceConfidence =
    weights.multipleConsumers *
      // consumer breadth saturates at what shape detection calls high fan-in
      clamp01((incoming.length - 1) / (config.dependency.shape.highFanIn - 1)) +
    weights.lowConcentration * (1 - primary.referenceShare) +
    weights.broadDistribution *
      clamp01(
        (dependencies.averageSymbolDistribution - 1) /
          (broadDistributionCeiling - 1)
      );

  const name = boundaryName(boundary);
  return {
    cautions: [],
    estimatedReduction: [],
    evidence: [
      {
        metric: "consumerPackages",
        significance: "strong",
        value: incoming.length,
      },
      {
        metric: "referenceConcentration",
        significance: "strong",
        value: primary.referenceShare,
      },
      {
        metric: "averageSymbolDistribution",
        significance: "supporting",
        value: dependencies.averageSymbolDistribution,
      },
    ],
    evidenceConfidence,
    id: `preserve-shared-boundary:${name}`,
    operation: "preserve-shared-boundary",
    subject: { id: name, name, type: "package" },
    summary: `${name} exposes independently consumed surface across ${incoming.length} packages; the existing package boundary appears meaningful.`,
  };
}

const OPERATION_SEVERITY: Record<ReductionOperation, number> = {
  "fold-package": 0,
  "internalize-symbol": 1,
  "preserve-shared-boundary": 2,
};

export interface OpportunityAnalysis {
  ineligibleOperations: IneligibleOperation[];
  opportunities: ReductionOpportunity[];
}

export function buildOpportunities(
  boundary: Boundary,
  symbols: SurfaceSymbol[],
  dependencies: SurfaceDependencies,
  config: AnalysisConfig = ANALYSIS_CONFIG
): OpportunityAnalysis {
  const opportunities = internalizeOpportunities(symbols);
  const ineligibleOperations: IneligibleOperation[] = [];

  const packageDetectors: {
    operation: ReductionOperation;
    gates: FailedGate[];
    detect: () => ReductionOpportunity | undefined;
  }[] = [
    {
      detect: () => foldOpportunity(boundary, symbols, dependencies, config),
      gates: foldGates(dependencies, config),
      operation: "fold-package",
    },
    {
      detect: () => preserveOpportunity(boundary, dependencies, config),
      gates: preserveGates(dependencies, config),
      operation: "preserve-shared-boundary",
    },
  ];
  if (dependencies.consumerPackages > 0) {
    for (const detector of packageDetectors) {
      if (detector.gates.length > 0) {
        ineligibleOperations.push({
          failedGates: detector.gates,
          operation: detector.operation,
        });
        continue;
      }
      const opportunity = detector.detect();
      if (opportunity) {
        opportunities.push(opportunity);
      }
    }
  }

  opportunities.sort(
    (a, b) =>
      OPERATION_SEVERITY[a.operation] - OPERATION_SEVERITY[b.operation] ||
      b.evidenceConfidence - a.evidenceConfidence ||
      a.subject.name.localeCompare(b.subject.name)
  );
  return { ineligibleOperations, opportunities };
}
