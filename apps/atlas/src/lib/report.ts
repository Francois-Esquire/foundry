import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import { renderRecenteringSection } from "./report-recentering";
import type {
  ArchitecturalProfileEvidence,
  ArchitecturalTension,
  BoundaryInteraction,
  BoundaryInteractionTotals,
  BoundaryModuleContribution,
  ChangeCouplingPair,
  ChurnFileKind,
  CommitRadius,
  ConceptBehavioralLocality,
  ConceptBehavioralLocalityReport,
  ConceptDistance,
  ConceptDistributionAnalysis,
  ConceptDistributionShape,
  ConceptFamily,
  ConceptOverlapCandidate,
  ConceptOverlapReport,
  ConceptOwnershipAnalysis,
  ConceptOwnershipReport,
  ConceptRepresentation,
  ConceptRepresentationRelationship,
  DependencyGravity,
  EvolutionaryEvidence,
  FileChangeCouplingPair,
  FileChurn,
  FileHotspot,
  FoldPackagePlan,
  FunctionComplexity,
  InternalizeSymbolPlan,
  MetricAggregate,
  MetricDistribution,
  ModuleEdgeConcentration,
  MutationResult,
  PressureDimension,
  PressureEvidence,
  ReductionEvidence,
  ReductionOpportunity,
  ReductionPlan,
  StructuralDelta,
  SurfaceReport,
  SurfaceSymbol,
  TemporalMemberCoupling,
} from "./types";

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function usedSymbols(report: SurfaceReport): SurfaceSymbol[] {
  return report.symbols.filter(
    (symbol) =>
      symbol.exported &&
      symbol.externalReferences + symbol.externalImportSites > 0
  );
}

function renderDependencies(
  report: SurfaceReport,
  lines: string[],
  config: AnalysisConfig
): void {
  const { dependencies } = report;

  lines.push("");
  lines.push("DEPENDENCY CONTEXT");
  lines.push(
    `  Consumers     ${plural(dependencies.consumerPackages, "package")}`
  );
  lines.push(
    `  Dependencies  ${plural(dependencies.dependencyPackages, "package")}`
  );
  const primary = dependencies.primaryConsumer;
  if (primary) {
    lines.push(`  Primary consumer  ${primary.package}`);
    lines.push("");
    lines.push("  Reference concentration");
    lines.push(`    ${primary.package}  ${percent(primary.referenceShare)}`);
    lines.push("");
    lines.push("  Surface concentration");
    lines.push(`    ${primary.package}  ${percent(primary.surfaceShare)}`);
  }
  if (dependencies.consumerPackages > 0) {
    lines.push("");
    lines.push(
      `  Average symbol distribution  ${dependencies.averageSymbolDistribution.toFixed(2)} packages`
    );
  }

  if (dependencies.shapeSignals.length > 0) {
    lines.push("");
    lines.push("PACKAGE SHAPE");
    for (const signal of dependencies.shapeSignals) {
      lines.push(`  ${signal.replace(/-/g, " ")}`);
    }
  }

  if (dependencies.incoming.length > 0) {
    lines.push("");
    lines.push("CONSUMERS");
    for (const consumer of dependencies.incoming) {
      lines.push("");
      lines.push(`  ${consumer.package}`);
      lines.push(
        `    ${plural(consumer.symbolsUsed, "symbol")} · ${consumer.references} references · ${consumer.usageNamespace} usage`
      );
      const shown = config.report.symbolsPerConsumer;
      for (const symbol of consumer.symbols.slice(0, shown)) {
        lines.push(`    ${symbol.symbolName.padEnd(24)} ${symbol.references}`);
      }
      const remaining = consumer.symbols.length - shown;
      if (remaining > 0) {
        lines.push(`    … ${plural(remaining, "more symbol")}`);
      }
    }
  }

  if (dependencies.outgoing.length > 0) {
    lines.push("");
    lines.push("DEPENDS ON");
    for (const dependency of dependencies.outgoing) {
      lines.push(
        `  ${dependency.package.padEnd(28)} ${plural(dependency.moduleEdges, "module edge")}`
      );
    }
  }
}

function evidenceValue(
  opportunity: ReductionOpportunity,
  metric: string
): string | number | boolean | undefined {
  return opportunity.evidence.find((entry) => entry.metric === metric)?.value;
}

function renderOpportunities(report: SurfaceReport, lines: string[]): void {
  const preserved = report.opportunities.filter(
    (opportunity) => opportunity.operation === "preserve-shared-boundary"
  );
  const folds = report.opportunities.filter(
    (opportunity) => opportunity.operation === "fold-package"
  );
  const internalize = report.opportunities.filter(
    (opportunity) => opportunity.operation === "internalize-symbol"
  );

  if (folds.length > 0 || internalize.length > 0) {
    lines.push("");
    lines.push("REDUCTION OPPORTUNITIES");
    for (const opportunity of folds) {
      lines.push("");
      lines.push(
        `  FOLD CANDIDATE  ${opportunity.subject.name} → ${opportunity.target?.name ?? "?"}`
      );
      lines.push(
        `    Evidence confidence ${percent(opportunity.evidenceConfidence)}`
      );
      lines.push(
        `    ${plural(Number(evidenceValue(opportunity, "consumerPackages")), "consumer package")}` +
          ` · ${percent(Number(evidenceValue(opportunity, "referenceConcentration")))} reference concentration` +
          ` · ${percent(Number(evidenceValue(opportunity, "surfaceConcentration")))} surface concentration` +
          ` · ${evidenceValue(opportunity, "oneWayDependency") === true ? "one-way" : "cyclical"} dependency`
      );
      for (const caution of opportunity.cautions) {
        lines.push(`    Caution: ${caution.detail}`);
      }
      const exports = opportunity.estimatedReduction.find(
        (entry) => entry.metric === "potentiallyInternalizedExports"
      );
      lines.push(
        "    Potential reduction: 1 package boundary" +
          (exports
            ? ` · up to ${plural(exports.value, "public export")}`
            : "") +
          " · 1 dependency edge"
      );
      const plan = report.plans.find(
        (candidate) =>
          candidate.operation === "fold-package" &&
          candidate.source.package === opportunity.subject.id
      );
      if (plan) {
        const scale = plan.intelligence?.scale;
        lines.push(
          `    Plan ${plan.status}` +
            (scale === undefined
              ? ""
              : ` · ${plural(scale.files.total, "file")} · ${scale.symbols.externallyUsed} consumed / ${scale.symbols.packagePublic} public`)
        );
      }
    }
    const first = internalize[0];
    if (first) {
      lines.push("");
      lines.push(
        `  INTERNALIZE SYMBOLS  ${plural(internalize.length, "unused external export")} · evidence confidence ${percent(first.evidenceConfidence)}`
      );
      const count = (status: ReductionPlan["status"]) =>
        report.plans.filter(
          (plan) =>
            plan.operation === "internalize-symbol" && plan.status === status
        ).length;
      const blocked = count("blocked");
      lines.push(
        `    ${count("ready")} plan-ready` +
          (blocked > 0 ? ` · ${blocked} blocked` : "") +
          ` · ${count("unsupported")} unsupported`
      );
      const reasons = Object.entries(
        report.operators.find(
          (operator) => operator.id === "internalize-export"
        )?.unsupportedReasons ?? {}
      );
      if (reasons.length > 0) {
        lines.push(
          `    Unsupported: ${reasons
            .map(([reason, total]) => `${reason} ${total}`)
            .join(" · ")}`
        );
      }
    }
  }

  if (preserved.length > 0) {
    lines.push("");
    lines.push("BOUNDARIES TO PRESERVE");
    const primary = report.dependencies.primaryConsumer;
    for (const opportunity of preserved) {
      lines.push("");
      lines.push(`  ${opportunity.subject.name}`);
      lines.push(
        `    Evidence confidence ${percent(opportunity.evidenceConfidence)}`
      );
      lines.push(
        `    ${plural(report.dependencies.consumerPackages, "consumer package")}` +
          (primary
            ? ` · largest consumer ${percent(primary.referenceShare)} of references`
            : "")
      );
      lines.push("    Existing package boundary appears meaningful.");
    }
  }
}

function planEvidenceLine(evidence: ReductionEvidence): string {
  if (evidence.metric === "packagePublic" && evidence.value === true) {
    return "package-public";
  }
  if (evidence.metric === "externalReferences") {
    return `${evidence.value} external references`;
  }
  if (evidence.metric === "externalConsumers") {
    return `${evidence.value} external consumers`;
  }
  return `${evidence.metric} ${evidence.value}`;
}

function renderInternalizePlan(plan: InternalizeSymbolPlan): string {
  const lines: string[] = [];
  lines.push("INTERNALIZATION PLAN");
  lines.push("═".repeat(20));
  lines.push(`Target  ${plan.target.package}`);
  lines.push(`Symbol  ${plan.subject.name}`);
  lines.push("");
  lines.push(`Status  ${plan.status.toUpperCase()}`);

  if (plan.evidence.length > 0) {
    lines.push("");
    lines.push("EVIDENCE");
    for (const evidence of plan.evidence) {
      lines.push(`  ${planEvidenceLine(evidence)}`);
    }
  }

  const intelligence = plan.intelligence;
  if (intelligence !== undefined) {
    lines.push("");
    lines.push("PLAN SCALE");
    lines.push(`  files affected  ${intelligence.scale.files.total}`);
    const routes = intelligence.surface.publicRoutes;
    if (routes !== undefined) {
      lines.push(
        `  public routes   ${routes.total}` +
          (routes.unsupported > 0
            ? ` (${routes.supported} supported · ${routes.unsupported} unsupported)`
            : "")
      );
    }
    lines.push("");
    lines.push("INTENT");
    lines.push(
      `  package anchored    ${intelligence.intent.anchored ? "yes" : "no"}`
    );
    lines.push("  boundary preserved  yes");
  }

  if (plan.publicRoutes.length > 0) {
    lines.push("");
    lines.push(
      plan.publicRoutes.length === 1
        ? "PUBLIC ROUTE"
        : `PUBLIC ROUTES  ${plan.publicRoutes.length}`
    );
    for (const route of plan.publicRoutes) {
      lines.push("");
      lines.push(`  ${route.file}  (${route.entrypoint})`);
      if (route.chain.length > 2) {
        lines.push(`    via ${route.chain.slice(1).join(" → ")}`);
      }
      lines.push(
        `    ${route.statement ?? `declared here as ${route.exportedName}`}`
      );
    }
  }

  if (plan.plannedChanges.length > 0) {
    lines.push("");
    lines.push(
      plan.plannedChanges.length === 1 ? "PLANNED CHANGE" : "PLANNED CHANGES"
    );
    for (const change of plan.plannedChanges) {
      lines.push("");
      lines.push(`  ${change.file}`);
      lines.push(`    ${change.description}`);
    }
  }

  if (plan.blockers.length > 0) {
    lines.push("");
    lines.push("BLOCKERS");
    for (const blocker of plan.blockers) {
      lines.push(`  ${blocker.reason}: ${blocker.detail}`);
    }
  }

  if (plan.preservedBehavior.length > 0) {
    lines.push("");
    lines.push("PRESERVED");
    for (const preserved of plan.preservedBehavior) {
      lines.push(`  ${preserved}`);
    }
  }

  const delta = plan.predictedDelta;
  lines.push("");
  lines.push("PREDICTED SURFACE DELTA");
  lines.push(`  total symbols            ${signed(delta.totalSymbols ?? 0)}`);
  lines.push(
    `  exported symbols         ${signed(delta.exportedSymbols ?? 0)}`
  );
  lines.push(
    `  externally used symbols  ${signed(delta.externallyUsedSymbols ?? 0)}`
  );
  lines.push(
    `  unused external exports  ${signed(delta.unusedExternalExports ?? 0)}`
  );
  lines.push("");
  lines.push("MODE");
  lines.push("  READ ONLY");
  lines.push("");
  return lines.join("\n");
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}

function foldEvidenceLine(evidence: ReductionEvidence): string {
  const numeric = Number(evidence.value);
  switch (evidence.metric) {
    case "consumerPackages":
      return numeric === 1 ? "single consumer" : `${numeric} consumer packages`;
    case "referenceConcentration":
      return `reference concentration ${percent(numeric)}`;
    case "surfaceConcentration":
      return `surface concentration ${percent(numeric)}`;
    case "averageSymbolDistribution":
      return `average symbol distribution ${numeric.toFixed(2)}`;
    case "oneWayDependency":
      return evidence.value === true
        ? "one-way dependency"
        : "cyclical dependency";
    default:
      return `${evidence.metric} ${evidence.value}`;
  }
}

function renderFoldPlan(plan: FoldPackagePlan): string {
  const lines: string[] = [];
  lines.push("PACKAGE FOLD PLAN");
  lines.push("═".repeat(17));
  lines.push(`Source       ${plan.source.package}`);
  lines.push(`Destination  ${plan.destination.package}`);
  lines.push("");
  lines.push(`Status       ${plan.status.toUpperCase()}`);

  if (plan.evidence.length > 0) {
    lines.push("");
    lines.push("EVIDENCE");
    for (const evidence of plan.evidence) {
      lines.push(`  ${foldEvidenceLine(evidence)}`);
    }
  }

  if (plan.cautions.length > 0) {
    lines.push("");
    lines.push("CAUTIONS");
    for (const caution of plan.cautions) {
      lines.push(`  ${caution.detail}`);
    }
  }

  const intelligence = plan.intelligence;
  if (intelligence !== undefined) {
    const { scale, surface, boundary, intent } = intelligence;
    lines.push("");
    lines.push("PLAN SCALE");
    lines.push(`  files                 ${scale.files.total}`);
    lines.push(`  source files          ${scale.files.source}`);
    lines.push(`  test files            ${scale.files.test}`);
    lines.push(
      `  config/other          ${scale.files.config + scale.files.other}`
    );
    lines.push("");
    lines.push(`  symbols               ${scale.symbols.total}`);
    lines.push(`  module exports        ${scale.symbols.moduleExported}`);
    lines.push(`  package-public        ${scale.symbols.packagePublic}`);
    lines.push(`  consumed              ${scale.symbols.externallyUsed}`);
    lines.push("");
    lines.push("SURFACE");
    lines.push(
      `  consumed / exported       ${surface.consumedSurfaceRatio === null ? "n/a" : percent(surface.consumedSurfaceRatio)}`
    );
    lines.push(
      `  unused external surface   ${surface.unusedExternalSurfaceRatio === null ? "n/a" : percent(surface.unusedExternalSurfaceRatio)}`
    );
    if (
      surface.referenceDensity !== undefined &&
      surface.referenceDensity !== null
    ) {
      lines.push(
        `  references per consumed   ${surface.referenceDensity.toFixed(1)}`
      );
    }
    lines.push("");
    lines.push("BOUNDARY");
    lines.push(
      `  ${plural(boundary.importSitesCrossingBoundary, "import site")} · ${plural(boundary.moduleEdgesCrossingBoundary, "module edge")} · ${plan.boundaryUsage.usageNamespace} usage`
    );
    lines.push(
      `  ${plural(boundary.consumerPackages, "consumer package")} · ${plural(boundary.dependencyPackages, "dependency package")}`
    );
    if (boundary.flow !== undefined) {
      lines.push(
        `  destination → source  ${boundary.flow.destinationToSource ? "yes" : "no"}`
      );
      lines.push(
        `  source → destination  ${boundary.flow.sourceToDestination ? "yes" : "no"}`
      );
      lines.push(
        `  cycle                 ${boundary.flow.cycle ? "yes" : "no"}`
      );
    }
    lines.push("");
    lines.push("INTENT");
    lines.push(`  anchored          ${intent.anchored ? "yes" : "no"}`);
    for (const anchor of intent.anchors) {
      if (anchor.reason !== undefined) {
        lines.push(`  reason            ${anchor.reason}`);
      }
    }
    lines.push(`  publishable       ${intent.publishable ? "yes" : "no"}`);
    lines.push(`  designed exports  ${intent.designedExports ? "yes" : "no"}`);
  }

  if (plan.consumedSurface.length > 0) {
    lines.push("");
    lines.push("TOP CONSUMED SYMBOLS");
    for (const symbol of plan.consumedSurface.slice(0, 5)) {
      lines.push(
        `  ${symbol.symbolName.padEnd(24)} ${plural(symbol.references, "reference")} · ${symbol.usageNamespace}`
      );
    }
  }

  if (plan.potentiallyInternalized.length > 0) {
    lines.push("");
    lines.push("POTENTIALLY INTERNALIZED");
    lines.push(`  ${plural(plan.potentiallyInternalized.length, "symbol")}`);
  }

  lines.push("");
  lines.push("DESTINATION");
  lines.push(
    plan.destination.directory === undefined
      ? `  ${plan.destination.path ?? plan.destination.package} · directory unresolved`
      : `  ${plan.destination.path ?? plan.destination.package} · directory ${plan.destination.directory} (${plan.destination.resolution})`
  );

  if (plan.packageMetadata.length > 0) {
    const byKind = new Map<string, number>();
    for (const impact of plan.packageMetadata) {
      byKind.set(impact.kind, (byKind.get(impact.kind) ?? 0) + 1);
    }
    lines.push("");
    lines.push("METADATA IMPACT");
    lines.push(
      "  " +
        [...byKind.entries()]
          .map(([kind, count]) => `${kind} ${count}`)
          .join(" · ")
    );
    for (const impact of plan.packageMetadata) {
      lines.push(`  ${impact.file}`);
      lines.push(`    ${impact.detail}`);
    }
  }

  if (plan.plannedChanges.length > 0) {
    lines.push("");
    lines.push("PLANNED CHANGES");
    for (const change of plan.plannedChanges) {
      lines.push(`  ${change.description}`);
    }
  }

  if (plan.blockers.length > 0) {
    lines.push("");
    lines.push("BLOCKERS");
    for (const blocker of plan.blockers) {
      lines.push(`  ${blocker.reason}: ${blocker.detail}`);
    }
  }

  const { certain, potential } = plan.predictedDelta;
  lines.push("");
  lines.push("PREDICTED DELTA");
  if (certain.packageBoundaries !== undefined) {
    lines.push(
      `  package boundaries        ${signed(certain.packageBoundaries)}`
    );
  }
  if (certain.packageDependencyEdges !== undefined) {
    lines.push(
      `  package dependency edges  ${signed(certain.packageDependencyEdges)}`
    );
  }
  if (certain.filesMoved !== undefined) {
    lines.push(`  files relocated            ${certain.filesMoved}`);
  }
  if (certain.importSitesRewritten !== undefined) {
    lines.push(`  import sites rewritten     ${certain.importSitesRewritten}`);
  }
  if (potential.exportedSymbols !== undefined) {
    lines.push(
      `  potentially public        up to ${signed(potential.exportedSymbols)} symbols`
    );
  }
  lines.push("");
  lines.push("MODE");
  lines.push("  READ ONLY");
  lines.push("");
  return lines.join("\n");
}

export function renderPlan(plan: ReductionPlan): string {
  return plan.operation === "fold-package"
    ? renderFoldPlan(plan)
    : renderInternalizePlan(plan);
}

export function renderReport(
  report: SurfaceReport,
  config: AnalysisConfig = ANALYSIS_CONFIG
): string {
  const lines: string[] = [];
  const { summary } = report;

  lines.push("SEMANTIC SURFACE");
  lines.push("═".repeat(16));
  lines.push(`Target  ${report.target.name ?? report.target.path}`);
  lines.push(`Path    ${report.target.path}`);
  if (report.anchor !== undefined) {
    lines.push("");
    lines.push("ANCHOR");
    lines.push(`  ${report.anchor.reason ?? report.anchor.target}`);
  }
  lines.push("");
  lines.push("INVENTORY");
  lines.push(
    `  ${summary.totalSymbols} symbols · ${summary.moduleExportedSymbols} module exports · ${summary.packagePublicSymbols} package-public`
  );
  lines.push(
    `  ${summary.externallyUsedSymbols} used externally · ${summary.unusedExternalExports} unused external exports · ${summary.moduleOnlyExports} module-only`
  );
  lines.push("");
  lines.push("SURFACE SIGNALS");
  lines.push(
    `  Declared package surface  ${percent(summary.declaredSurfaceRatio)}`
  );
  lines.push(
    `  External surface          ${percent(summary.externalSurfaceRatio)}`
  );
  lines.push(
    `  Export utilization        ${percent(summary.exportUtilization)}`
  );

  renderDependencies(report, lines, config);
  renderGravitySummary(report, lines);
  renderProfileSummary(report, lines);
  renderBoundariesSummary(report, lines);
  renderPressureSummary(report, lines);
  renderChurnSummary(report, lines);
  renderHotspotsSummary(report, lines);
  renderCouplingSummary(report, lines);
  renderRadiusSummary(report, lines);
  renderEvolutionSummary(report, lines);
  renderConceptsSummary(report, lines);
  renderOpportunities(report, lines);

  const used = usedSymbols(report);

  const distributed = [...used]
    .sort(
      (a, b) =>
        b.consumerPackages.length - a.consumerPackages.length ||
        b.externalReferences - a.externalReferences ||
        a.name.localeCompare(b.name)
    )
    .slice(0, 5);
  if (distributed.length > 0) {
    lines.push("");
    lines.push("MOST DISTRIBUTED");
    for (const symbol of distributed) {
      lines.push("");
      lines.push(`  ${symbol.name}`);
      lines.push(
        `    ${symbol.kind} · ${plural(symbol.consumerPackages.length, "package")} · ${symbol.externalReferences} references`
      );
      lines.push(
        `    ${symbol.usageNamespace} usage · ${symbol.access} access`
      );
    }
  }

  const concentrated = used
    .filter(
      (symbol) =>
        symbol.consumerPackages.length === 1 && symbol.externalReferences > 0
    )
    .sort(
      (a, b) =>
        b.externalReferences - a.externalReferences ||
        a.name.localeCompare(b.name)
    )
    .slice(0, 5);
  if (concentrated.length > 0) {
    lines.push("");
    lines.push("CONCENTRATED");
    for (const symbol of concentrated) {
      const primary = symbol.consumers[0];
      lines.push("");
      lines.push(`  ${symbol.name}`);
      lines.push(`    ${plural(symbol.consumerPackages.length, "package")}`);
      if (primary) {
        lines.push(`    Primary consumer  ${primary.boundary}`);
      }
      lines.push(
        `    ${symbol.externalReferences} references · ${percent(symbol.primaryConsumerShare)} concentrated`
      );
    }
  }

  const truncatedList = (names: string[]) => {
    for (const name of names.slice(0, config.report.unusedExportsShown)) {
      lines.push(`  ${name}`);
    }
    const remaining = names.length - config.report.unusedExportsShown;
    if (remaining > 0) {
      lines.push(`  … ${remaining} more`);
    }
  };

  const unused = report.symbols
    .filter(
      (symbol) =>
        symbol.packagePublic &&
        symbol.externalReferences + symbol.externalImportSites === 0
    )
    .map((symbol) => symbol.name)
    .sort((a, b) => a.localeCompare(b));
  if (unused.length > 0) {
    lines.push("");
    lines.push("UNUSED EXTERNAL EXPORTS");
    lines.push("");
    truncatedList(unused);
  }

  const moduleOnly = report.symbols
    .filter((symbol) => symbol.exported && !symbol.packagePublic)
    .map((symbol) => symbol.name)
    .sort((a, b) => a.localeCompare(b));
  if (moduleOnly.length > 0) {
    lines.push("");
    lines.push("MODULE-ONLY EXPORTS");
    lines.push("");
    truncatedList(moduleOnly);
  }

  renderComplexitySummary(report, lines);

  lines.push("");
  lines.push("OPERATORS");
  for (const operator of report.operators) {
    const counts =
      operator.opportunities === 0
        ? "no opportunity"
        : `${plural(operator.opportunities, "candidate")} · ${operator.plans.ready} plan-ready` +
          (operator.plans.blocked > 0
            ? ` · ${operator.plans.blocked} blocked`
            : "") +
          (operator.plans.unsupported > 0
            ? ` · ${operator.plans.unsupported} unsupported`
            : "");
    lines.push(
      `  ${operator.id.padEnd(20)} ${counts} · mutation ${operator.capabilities.apply ? "supported" : "unsupported"}`
    );
  }

  lines.push("");
  lines.push("MODE");
  lines.push("  ANALYZE");
  lines.push("");
  return lines.join("\n");
}

function renderGravitySummary(report: SurfaceReport, lines: string[]): void {
  const { target } = report.dependencyGravity;
  lines.push("");
  lines.push("DEPENDENCY GRAVITY");
  lines.push(
    `  fan-in ${target.direct.fanIn} · fan-out ${target.direct.fanOut} packages`
  );
  lines.push(
    `  transitive ${target.transitive.dependents} dependents · ${target.transitive.dependencies} dependencies`
  );
  lines.push(
    `  reach ${percent(target.reach.dependents)} dependents · ${percent(target.reach.dependencies)} dependencies`
  );
  if (target.cycle.member) {
    lines.push(`  cycle member · ${plural(target.cycle.size, "package")}`);
  }
}

function renderProfileSummary(report: SurfaceReport, lines: string[]): void {
  const { signals } = report.architecturalProfile.target;
  if (signals.length === 0) {
    return;
  }
  lines.push("");
  lines.push("ARCHITECTURAL PROFILE");
  for (const result of signals) {
    lines.push(`  ${result.signal}`);
  }
}

function totalsLine(label: string, totals: BoundaryInteractionTotals): string {
  if (totals.packages === 0) {
    return `  ${label}  0 packages`;
  }
  const parts = [
    plural(totals.packages, "package"),
    plural(totals.moduleEdges, "module edge"),
    plural(totals.importSites, "import site"),
    plural(totals.symbols, "symbol"),
  ];
  if (totals.references !== null) {
    parts.push(plural(totals.references, "reference"));
  }
  return `  ${label}  ${parts.join(" · ")}`;
}

function renderBoundariesSummary(report: SurfaceReport, lines: string[]): void {
  const { summary } = report.boundaryInteractions;
  lines.push("");
  lines.push("BOUNDARY INTERACTIONS");
  lines.push(totalsLine("incoming", summary.incoming));
  lines.push(totalsLine("outgoing", summary.outgoing));
}

function renderPressureSummary(report: SurfaceReport, lines: string[]): void {
  const { signals, boundaries } = report.structuralPressure;
  if (signals.length === 0 && boundaries.length === 0) {
    return;
  }
  lines.push("");
  lines.push("STRUCTURAL PRESSURE");
  for (const signal of signals) {
    lines.push(`  ${signal.kind}`);
  }
  if (boundaries.length > 0) {
    if (signals.length > 0) {
      lines.push("");
    }
    lines.push(`  ${plural(boundaries.length, "boundary-pressure signal")}`);
  }
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

function ago(days: number | undefined): string {
  if (days === undefined) {
    return "never committed";
  }
  if (days === 0) {
    return "today";
  }
  return `${plural(days, "day")} ago`;
}

function windowLabel(windowDays: number | null): string {
  return windowDays === null ? "full history" : `last ${windowDays} days`;
}

function renderChurnSummary(report: SurfaceReport, lines: string[]): void {
  const { churn } = report;
  lines.push("");
  lines.push("CHURN");
  if (!churn.available) {
    lines.push(`  unavailable — ${churn.reason.replace(/-/g, " ")}`);
    return;
  }
  const { summary, history, target } = churn;
  lines.push(
    `  ${plural(summary.filesAnalyzed, "file")} · ${plural(summary.commits, "commit")} in ${windowLabel(history.windowDays)}${history.historyComplete ? "" : " (shallow clone)"}`
  );
  lines.push(
    `  ${count(summary.linesChanged)} lines changed · ${plural(summary.authors, "author")}`
  );
  lines.push(`  last changed ${ago(target.daysSinceLastChange)}`);
}

function renderHotspotsSummary(report: SurfaceReport, lines: string[]): void {
  const { hotspots } = report;
  if (!hotspots.available) {
    return;
  }
  lines.push("");
  lines.push("HOTSPOTS");
  const top = hotspots.files[0];
  if (top === undefined) {
    lines.push("  none under current policy");
    return;
  }
  lines.push(
    `  ${plural(hotspots.summary.hotspots, "source file")} of ${hotspots.summary.eligibleSourceFiles}`
  );
  lines.push(
    `  highest: ${top.file} · ${plural(top.evolution.commits, "commit")} · ${percent(top.evolution.commitPercentile)} commit percentile`
  );
}

function renderCouplingSummary(report: SurfaceReport, lines: string[]): void {
  const coupling = report.changeCoupling;
  if (!coupling.available) {
    return;
  }
  const { summary } = coupling;
  lines.push("");
  lines.push("CHANGE COUPLING");
  if (summary.filePairs === 0 && summary.packagePairs === 0) {
    lines.push("  no strong pairs under current policy");
    return;
  }
  lines.push(
    `  ${plural(summary.filePairs, "strong file pair")} · ${summary.crossPackagePairs} cross-package · ${plural(summary.packagePairs, "package pair")}`
  );
  lines.push(
    `  ${summary.filePairsWithoutStaticEdge} strong file ${summary.filePairsWithoutStaticEdge === 1 ? "pair has" : "pairs have"} no static dependency`
  );
}

function renderRadiusSummary(report: SurfaceReport, lines: string[]): void {
  const radius = report.changeRadius;
  if (!radius.available || radius.summary.commits === 0) {
    return;
  }
  const { summary } = radius;
  lines.push("");
  lines.push("CHANGE RADIUS");
  lines.push(
    `  packages/commit p50 ${summary.packages.p50} · p90 ${summary.packages.p90} · max ${summary.packages.max}`
  );
  lines.push(
    `  cross-package commits ${percent(summary.crossPackageRate)} · boundary-crossing ${percent(summary.boundaryCrossingRate)}`
  );
}

function renderConceptsSummary(report: SurfaceReport, lines: string[]): void {
  const { summary, families } = report.conceptInventory;
  if (summary.seeds === 0) {
    return;
  }
  lines.push("");
  lines.push("CONCEPTS");
  lines.push(
    `  ${plural(summary.seeds, "seed")} · ${summary.crossPackageFamilies} cross-package ${summary.crossPackageFamilies === 1 ? "family" : "families"} · ${plural(summary.implementations, "implementation")}`
  );
  const distribution = report.conceptInventory.distribution;
  if (distribution !== undefined) {
    lines.push(
      `  ${distribution.implementationSplit} implementation-split · ${distribution.referenceDistributed} reference-distributed · ${distribution.representationConcentrated} representation-concentrated${distribution.temporallyCoupled > 0 ? ` · ${distribution.temporallyCoupled} with co-changing members` : ""}`
    );
  }
  const top = families[0];
  if (top !== undefined && top.distribution.moduleCount > 1) {
    lines.push(
      `  most distributed: ${top.seed.name} · ${plural(top.distribution.packageCount, "package")} · ${plural(top.distribution.moduleCount, "module")}`
    );
  }
  const overlap = report.conceptOverlap.summary;
  if (overlap.candidates > 0) {
    lines.push(
      `  ${plural(overlap.candidates, "overlap candidate")} · ${overlap.crossPackageCandidates} cross-package · ${overlap.nearEquivalent} near-equivalent · ${overlap.conversionPairs} conversion pairs`
    );
  }
  const ownership = report.conceptOwnership.summary;
  lines.push(
    `  centers: ${ownership.aligned} aligned · ${ownership.distributed} distributed · ${ownership.divergent} divergent · ${ownership.insufficientEvidence} insufficient evidence`
  );
  const locality = report.conceptBehavioralLocality.summary;
  lines.push(
    `  locality: ${locality.local} local · ${locality.singlePackageDistributed} single-package · ${locality.crossPackageLocalized + locality.crossPackageDistributed} cross-package · ${locality.behaviorLight} behavior-light · ${locality.parallelImplementations} parallel implementations`
  );
  const recentering = report.recenteringCandidates.summary;
  lines.push(
    `  re-centering: ${recentering.candidates} candidates · ${recentering.protected} protected · ${recentering.insufficientEvidence} insufficient evidence`
  );
  const scenarios = report.recenteringCandidates.scenarios.summary;
  lines.push(
    `  scenarios: ${scenarios.findings} findings · ${scenarios.scenarios} scenarios · ${scenarios.plausible} plausible · ${scenarios.constrained} constrained · ${scenarios.blocked} blocked`
  );
  const impacts = report.recenteringCandidates.impacts.summary;
  lines.push(
    `  impacts: ${impacts.boundaryReductions} boundary reductions · ${impacts.boundaryEliminations} eliminations · ${impacts.localityDecreases} span contractions · ${impacts.surfaceRelocations} surface relocations · ${impacts.anchorConflicts} anchor conflicts`
  );
  const reviews = report.recenteringCandidates.reviews.summary;
  lines.push(
    `  reviews: ${reviews.findingsReviewed} findings · ${reviews.preserveCurrent} preserve current · ${reviews.credibleAlternative} credible alternative · ${reviews.multipleTradeoffs} multiple tradeoffs · ${reviews.intentBlocked} intent blocked · ${reviews.insufficientEvidence} insufficient evidence`
  );
}

function distanceLine(item: ConceptDistance): string {
  const parts: string[] = [];
  if (item.outward !== undefined) {
    parts.push(`${item.from} → ${item.to} distance ${item.outward}`);
  }
  if (item.inward !== undefined) {
    parts.push(`${item.to} → ${item.from} distance ${item.inward}`);
  }
  if (parts.length === 0) {
    parts.push(`${item.from} ↔ ${item.to} disconnected`);
  }
  if (item.viaAggregator === true) {
    parts.push("via aggregator");
  }
  return parts.join(" · ");
}

function localityLine(item: ConceptBehavioralLocality): string {
  const { span, traversal } = item;
  const parts = [
    plural(item.behavior.source, "source behavior"),
    plural(span.sourceModuleCount, "module"),
    plural(span.sourcePackageCount, "package"),
  ];
  if (span.packageBoundaryCount > 0) {
    parts.push(plural(span.packageBoundaryCount, "boundary edge"));
  }
  if (traversal.maxModuleDistance !== null) {
    parts.push(`max distance ${traversal.maxModuleDistance}`);
  }
  if (traversal.disconnectedPackagePairs > 0) {
    parts.push(
      `${traversal.disconnectedPackagePairs} disconnected package pairs`
    );
  }
  if (traversal.disconnectedModules > 0) {
    parts.push(`${traversal.disconnectedModules} disconnected modules`);
  }
  return parts.join(" · ");
}

function renderLocalitySection(
  locality: ConceptBehavioralLocalityReport,
  config: AnalysisConfig,
  lines: string[]
): void {
  const { summary, concepts } = locality;
  if (summary.analyzed === 0) {
    return;
  }
  const shown = config.behavioralLocality.report.topConcepts;
  lines.push("");
  lines.push("BEHAVIORAL LOCALITY");
  lines.push(
    `  ${summary.local} local · ${summary.singlePackageDistributed} single-package-distributed · ${summary.crossPackageLocalized} cross-package-localized · ${summary.crossPackageDistributed} cross-package-distributed · ${summary.behaviorLight} behavior-light · ${summary.insufficientEvidence} insufficient evidence · ${summary.parallelImplementations} parallel implementations`
  );
  for (const shape of [
    "cross-package-distributed",
    "cross-package-localized",
  ] as const) {
    const items = concepts
      .filter((item) => item.shape.primary === shape)
      .sort(
        (a, b) =>
          b.span.sourceModuleCount - a.span.sourceModuleCount ||
          b.span.sourcePackageCount - a.span.sourcePackageCount ||
          a.concept.name.localeCompare(b.concept.name)
      );
    if (items.length === 0) {
      continue;
    }
    lines.push(`  ${shape}`);
    for (const item of items.slice(0, shown)) {
      lines.push(
        `    ${item.concept.name.padEnd(32)} ${localityLine(item)}${item.shape.modifiers.length > 0 ? ` · ${item.shape.modifiers.join(", ")}` : ""}`
      );
    }
    if (items.length > shown) {
      lines.push(`    … ${items.length - shown} more (see --json)`);
    }
  }
}

function overlapLine(candidate: ConceptOverlapCandidate): string {
  const parts: string[] = [];
  if (candidate.structure !== undefined) {
    parts.push(
      `properties ${candidate.structure.shared.length} shared · Jaccard ${percent(candidate.structure.jaccard)}`
    );
  }
  if (candidate.assignability !== undefined) {
    parts.push(`assignable ${candidate.assignability}`);
  }
  if (candidate.conversions.length > 0) {
    parts.push(
      `${candidate.bidirectionalConversion ? "bidirectional " : ""}converters ${[...new Set(candidate.conversions.map((item) => item.function))].slice(0, 3).join(", ")}`
    );
  }
  if (candidate.temporalContext !== undefined) {
    parts.push(
      `${plural(candidate.temporalContext.coChangeCommits, "co-change commit")} (${candidate.temporalContext.context})`
    );
  }
  return parts.join(" · ");
}

function renderCandidate(
  candidate: ConceptOverlapCandidate,
  lines: string[]
): void {
  lines.push("");
  lines.push(`  ${candidate.left.name}  ↔  ${candidate.right.name}`);
  lines.push(
    `    ${candidate.left.package} ↔ ${candidate.right.package}${candidate.crossPackage ? " · cross-package" : ""}`
  );
  lines.push(`    ${candidate.shapes.join(" · ")}`);
  lines.push(`    ${candidate.dimensions.join(" + ")}`);
  const detail = overlapLine(candidate);
  if (detail !== "") {
    lines.push(`    ${detail}`);
  }
  if (candidate.name !== undefined) {
    lines.push(`    name tokens ${candidate.name.sharedTokens.join(", ")}`);
  }
  lines.push(`    ${candidate.left.file}`);
  lines.push(`    ${candidate.right.file}`);
}

function renderOverlapSection(
  overlap: ConceptOverlapReport,
  config: AnalysisConfig,
  lines: string[]
): void {
  const { summary, generation } = overlap;
  lines.push("");
  lines.push("CONCEPT OVERLAP");
  lines.push(`  candidates                ${summary.candidates}`);
  lines.push(`  cross-package             ${summary.crossPackageCandidates}`);
  lines.push(`  near-equivalent           ${summary.nearEquivalent}`);
  lines.push(`  projection-like           ${summary.projectionLike}`);
  lines.push(
    `  conversion pairs          ${summary.conversionPairs} (${summary.bidirectionalConversionPairs} bidirectional)`
  );
  lines.push(`  structurally overlapping  ${summary.structurallyOverlapping}`);
  lines.push(
    `  generated ${generation.pairsGenerated.total} pairs from ${generation.seeds} seeds × ${generation.indexedDeclarations} declarations (name ${generation.pairsGenerated.name} · property ${generation.pairsGenerated.property} · conversion ${generation.pairsGenerated.conversion} · temporal ${generation.pairsGenerated.temporal})`
  );
  const shown = overlap.candidates.slice(
    0,
    config.conceptOverlap.report.topCandidates
  );
  for (const candidate of shown) {
    renderCandidate(candidate, lines);
  }
  const remaining = overlap.candidates.length - shown.length;
  if (remaining > 0) {
    lines.push(`  … ${remaining} more (see --json)`);
  }
}

const REPRESENTATION_LABELS: Record<ConceptRepresentationRelationship, string> =
  {
    alias: "aliases",
    extension: "extensions",
    factory: "factories",
    implementation: "implementations",
    other: "constructor users",
    "type-user": "type users",
  };

function familyShapeLine(family: ConceptFamily): string {
  const parts: string[] = [];
  const counts = new Map<ConceptRepresentationRelationship, number>();
  for (const representation of family.representations) {
    counts.set(
      representation.relationship,
      (counts.get(representation.relationship) ?? 0) + 1
    );
  }
  for (const [relationship, label] of Object.entries(REPRESENTATION_LABELS)) {
    const count = counts.get(relationship as ConceptRepresentationRelationship);
    if (count !== undefined) {
      parts.push(`${count} ${label}`);
    }
  }
  return parts.join(" · ");
}

function familyHeader(family: ConceptFamily, lines: string[]): void {
  const { seed, distribution } = family;
  lines.push("");
  lines.push(`  ${seed.name}`);
  lines.push(`    ${seed.kind} · declared in ${seed.declaration.package}`);
  lines.push(
    `    ${plural(distribution.packageCount, "package")} · ${plural(distribution.moduleCount, "module")} · ${plural(distribution.references, "structural reference")}`
  );
  const shape = familyShapeLine(family);
  if (shape !== "") {
    lines.push(`    ${shape}`);
  }
}

function representationLines(
  representations: ConceptRepresentation[],
  shown: number,
  lines: string[],
  withRelationship = false
): void {
  for (const representation of representations.slice(0, shown)) {
    const occurrences =
      representation.occurrences > 1 ? ` ×${representation.occurrences}` : "";
    const relationship = withRelationship
      ? ` · ${representation.relationship}`
      : "";
    lines.push(
      `      ${representation.name.padEnd(32)} ${representation.package}${relationship}${occurrences}  ${representation.file}`
    );
  }
  const remaining = representations.length - shown;
  if (remaining > 0) {
    lines.push(`      … ${remaining} more`);
  }
}

function centerLine(analysis: ConceptOwnershipAnalysis): string {
  const { center } = analysis;
  const parts: string[] = [];
  if (center.semantic !== undefined) {
    parts.push(`semantic ${center.semantic}`);
  }
  if (center.implementations.length > 0) {
    parts.push(`implementations ${center.implementations.join(", ")}`);
  }
  if (center.usage !== undefined) {
    parts.push(`usage ${center.usage}`);
  }
  if (center.representation !== undefined) {
    parts.push(`representation ${center.representation}`);
  }
  if (center.behavior !== undefined) {
    parts.push(`behavior ${center.behavior}`);
  }
  if (center.evolution !== undefined) {
    parts.push(`evolution ${center.evolution}`);
  }
  return parts.join(" · ");
}

function renderOwnershipSection(
  ownership: ConceptOwnershipReport,
  config: AnalysisConfig,
  lines: string[]
): void {
  const { summary, concepts } = ownership;
  if (summary.analyzed === 0) {
    return;
  }
  const shown = config.conceptOwnership.report.topConcepts;
  lines.push("");
  lines.push("CONCEPT OWNERSHIP");
  lines.push(
    `  ${summary.aligned} aligned · ${summary.distributed} distributed · ${summary.divergent} divergent · ${summary.insufficientEvidence} insufficient evidence · ${plural(summary.tensions, "tension")}`
  );
  const divergent = concepts.filter((item) => item.alignment === "divergent");
  if (divergent.length > 0) {
    lines.push("  divergent");
    for (const item of divergent.slice(0, shown)) {
      lines.push(`    ${item.concept.name.padEnd(32)} ${centerLine(item)}`);
      lines.push(
        `      ${item.tensions.map((tension) => `${tension.kind} → ${tension.observedPackage}`).join(" · ")}`
      );
    }
    if (divergent.length > shown) {
      lines.push(`    … ${divergent.length - shown} more (see --json)`);
    }
  }
  const distributed = concepts.filter(
    (item) => item.alignment === "distributed"
  );
  if (distributed.length > 0) {
    lines.push("  distributed");
    for (const item of distributed.slice(0, shown)) {
      lines.push(`    ${item.concept.name.padEnd(32)} ${centerLine(item)}`);
    }
    if (distributed.length > shown) {
      lines.push(`    … ${distributed.length - shown} more (see --json)`);
    }
  }
}

export function renderConcepts(
  report: Pick<SurfaceReport, "conceptInventory"> &
    Partial<
      Pick<
        SurfaceReport,
        | "conceptOverlap"
        | "conceptOwnership"
        | "conceptBehavioralLocality"
        | "recenteringCandidates"
      >
    >,
  config: AnalysisConfig = ANALYSIS_CONFIG
): string {
  const { target, summary, families } = report.conceptInventory;
  const { topFamilies, topRepresentations } = config.concepts.report;
  const lines: string[] = [];
  lines.push("CONCEPT INVENTORY");
  lines.push("═".repeat(17));
  lines.push(`Target  ${target}`);
  lines.push("");
  lines.push(`Seeds                    ${summary.seeds}`);
  lines.push(`Distributed families     ${summary.distributedFamilies}`);
  lines.push(`Cross-package families   ${summary.crossPackageFamilies}`);
  lines.push(`Implementations          ${summary.implementations}`);
  lines.push(`Aliases                  ${summary.aliases}`);

  const distributed = families
    .filter((family) => family.distribution.moduleCount > 1)
    .slice(0, topFamilies);
  if (distributed.length > 0) {
    lines.push("");
    lines.push("MOST DISTRIBUTED CONCEPTS");
    for (const family of distributed) {
      familyHeader(family, lines);
    }
  }

  const contracts = families
    .filter((family) => family.relationships.implements >= 2)
    .sort(
      (a, b) =>
        b.relationships.implements - a.relationships.implements ||
        b.distribution.packageCount - a.distribution.packageCount ||
        a.seed.name.localeCompare(b.seed.name)
    )
    .slice(0, topFamilies);
  if (contracts.length > 0) {
    lines.push("");
    lines.push("CONTRACT FAMILIES");
    for (const family of contracts) {
      familyHeader(family, lines);
      lines.push("    implementations");
      representationLines(
        family.representations.filter(
          (item) => item.relationship === "implementation"
        ),
        topRepresentations,
        lines
      );
    }
  }

  const crossPackage = families
    .filter((family) => family.distribution.packageCount > 1)
    .slice(0, topFamilies);
  if (crossPackage.length > 0) {
    lines.push("");
    lines.push("CROSS-PACKAGE FAMILIES");
    for (const family of crossPackage) {
      familyHeader(family, lines);
      const foreign = family.representations.filter(
        (item) => item.package !== family.seed.declaration.package
      );
      if (foreign.length > 0) {
        lines.push("    outside the seed package");
        representationLines(foreign, topRepresentations, lines, true);
      }
    }
    const remaining = summary.crossPackageFamilies - crossPackage.length;
    if (remaining > 0) {
      lines.push(`  … ${remaining} more`);
    }
  }

  renderDistributionSections(report.conceptInventory, config, lines);
  if (report.conceptOverlap !== undefined) {
    renderOverlapSection(report.conceptOverlap, config, lines);
  }
  if (report.conceptOwnership !== undefined) {
    renderOwnershipSection(report.conceptOwnership, config, lines);
  }
  if (report.conceptBehavioralLocality !== undefined) {
    renderLocalitySection(report.conceptBehavioralLocality, config, lines);
  }
  if (report.recenteringCandidates !== undefined) {
    renderRecenteringSection(report.recenteringCandidates, config, lines);
  }

  if (summary.seeds === 0) {
    lines.push("");
    lines.push("  no concept seeds in target");
  }
  return lines.join("\n");
}

function analysisOf(
  family: ConceptFamily
): ConceptDistributionAnalysis | undefined {
  return family.distributionAnalysis;
}

function shareLine(
  entries: { package: string; share: number }[],
  shown: number
): string {
  const parts = entries
    .slice(0, shown)
    .map((entry) => `${entry.package} ${percent(entry.share)}`);
  const remaining = entries.length - shown;
  if (remaining > 0) {
    parts.push(`… ${remaining} more`);
  }
  return parts.join(" · ");
}

function couplingLine(coupling: TemporalMemberCoupling): string {
  return `${coupling.left.representations.join("/")} ↔ ${coupling.right.representations.join("/")} · ${plural(coupling.coChangeCommits, "co-change commit")} · ${percent(coupling.leftConditional)} / ${percent(coupling.rightConditional)} · ${coupling.context} · static ${coupling.staticPath}`;
}

function renderDistributionSections(
  inventory: SurfaceReport["conceptInventory"],
  config: AnalysisConfig,
  lines: string[]
): void {
  const { topFamilies, topPackages } = config.conceptDistribution.report;
  const { families, distribution } = inventory;
  if (distribution === undefined) {
    return;
  }

  lines.push("");
  lines.push("DISTRIBUTION SHAPES");
  lines.push(`  local                        ${distribution.local}`);
  lines.push(`  cross-package                ${distribution.crossPackage}`);
  lines.push(
    `  implementation-split         ${distribution.implementationSplit}`
  );
  lines.push(
    `  reference-distributed        ${distribution.referenceDistributed}`
  );
  lines.push(
    `  representation-concentrated  ${distribution.representationConcentrated}`
  );
  lines.push(
    `  co-changing members          ${distribution.temporallyCoupled}`
  );

  const withShape = (shape: ConceptDistributionShape) =>
    families.filter((family) => analysisOf(family)?.shapes.includes(shape));

  const split = withShape("implementation-split")
    .sort((a, b) => {
      const left = analysisOf(a)?.representations.implementationPackages ?? 0;
      const right = analysisOf(b)?.representations.implementationPackages ?? 0;
      return right - left || a.seed.name.localeCompare(b.seed.name);
    })
    .slice(0, topFamilies);
  if (split.length > 0) {
    lines.push("");
    lines.push("IMPLEMENTATION-SPLIT FAMILIES");
    for (const family of split) {
      const analysis = analysisOf(family);
      if (analysis === undefined) {
        continue;
      }
      familyHeader(family, lines);
      lines.push(
        `    implementations in ${plural(analysis.representations.implementationPackages, "package")} · ${plural(analysis.representations.implementationModules, "module")}`
      );
      representationLines(
        family.representations.filter(
          (item) => item.relationship === "implementation"
        ),
        config.concepts.report.topRepresentations,
        lines
      );
    }
  }

  const distributed = withShape("reference-distributed")
    .sort((a, b) => {
      const left = analysisOf(a)?.references;
      const right = analysisOf(b)?.references;
      return (
        (right?.packageCount ?? 0) - (left?.packageCount ?? 0) ||
        (left?.primaryShare ?? 0) - (right?.primaryShare ?? 0) ||
        a.seed.name.localeCompare(b.seed.name)
      );
    })
    .slice(0, topFamilies);
  if (distributed.length > 0) {
    lines.push("");
    lines.push("REFERENCE-DISTRIBUTED FAMILIES");
    for (const family of distributed) {
      const analysis = analysisOf(family);
      if (analysis === undefined) {
        continue;
      }
      familyHeader(family, lines);
      lines.push(
        `    references  ${shareLine(analysis.references.byPackage, topPackages)}`
      );
    }
  }

  const concentrated = withShape("representation-concentrated")
    .sort((a, b) => {
      const left = analysisOf(a);
      const right = analysisOf(b);
      return (
        (right?.references.packageCount ?? 0) -
          (left?.references.packageCount ?? 0) ||
        (right?.representations.primaryShare ?? 0) -
          (left?.representations.primaryShare ?? 0) ||
        a.seed.name.localeCompare(b.seed.name)
      );
    })
    .slice(0, topFamilies);
  if (concentrated.length > 0) {
    lines.push("");
    lines.push("REPRESENTATION-CONCENTRATED FAMILIES");
    for (const family of concentrated) {
      const analysis = analysisOf(family);
      if (analysis === undefined) {
        continue;
      }
      familyHeader(family, lines);
      lines.push(
        `    representations  ${analysis.representations.primaryPackage ?? "?"} ${percent(analysis.representations.primaryShare ?? 0)} of ${analysis.representations.total}`
      );
      lines.push(
        `    references       ${shareLine(analysis.references.byPackage, topPackages)}`
      );
    }
  }

  const coupled = families
    .filter(
      (family) =>
        (analysisOf(family)?.temporal?.strongMemberCouplings.length ?? 0) > 0
    )
    .sort((a, b) => {
      const left = analysisOf(a)?.temporal?.strongMemberCouplings[0];
      const right = analysisOf(b)?.temporal?.strongMemberCouplings[0];
      return (
        (right?.coChangeCommits ?? 0) - (left?.coChangeCommits ?? 0) ||
        a.seed.name.localeCompare(b.seed.name)
      );
    })
    .slice(0, topFamilies);
  if (coupled.length > 0) {
    lines.push("");
    lines.push("CO-CHANGING FAMILY MEMBERS");
    for (const family of coupled) {
      const temporal = analysisOf(family)?.temporal;
      if (temporal === undefined) {
        continue;
      }
      familyHeader(family, lines);
      for (const coupling of temporal.strongMemberCouplings.slice(
        0,
        topPackages
      )) {
        lines.push(`    ${couplingLine(coupling)}`);
      }
    }
  }
}

function renderOwnership(
  analysis: ConceptOwnershipAnalysis,
  ownership: ConceptOwnershipReport,
  lines: string[]
): void {
  const { center } = analysis;
  const seed = analysis.concept.package;
  const candidate = (name: string) =>
    analysis.candidates.find((item) => item.package === name);
  const shareOf = (
    name: string,
    dimension: string,
    metric: string,
    label: string
  ): string => {
    const value = candidate(name)?.evidence.find(
      (item) => item.dimension === dimension && item.metric === metric
    )?.value;
    return typeof value === "number" ? ` · ${percent(value)} of ${label}` : "";
  };
  lines.push("");
  lines.push("OWNERSHIP");
  lines.push(`  alignment          ${analysis.alignment}`);
  if (analysis.alignment === "insufficient-evidence") {
    lines.push("  no centers inferred");
  } else {
    lines.push(`  semantic center    ${center.semantic ?? "—"}`);
    lines.push(
      `  implementations    ${center.implementations.length > 0 ? center.implementations.join(", ") : "none"}`
    );
    lines.push(
      `  usage center       ${center.usage === undefined ? "none" : `${center.usage}${shareOf(center.usage, "reference", "share", "references")}`}`
    );
    lines.push(
      `  representation     ${center.representation === undefined ? "none" : `${center.representation}${shareOf(center.representation, "representation", "sourceShare", "source representations")}`}`
    );
    lines.push(
      `  behavior center    ${center.behavior === undefined ? "none" : `${center.behavior}${shareOf(center.behavior, "behavior", "sourceContractShare", "source contract behaviors")}`}`
    );
    lines.push(`  evolution center   ${center.evolution ?? "none"}`);
  }
  if (analysis.tensions.length > 0) {
    lines.push("  tensions");
    for (const tension of analysis.tensions) {
      lines.push(
        `    ${tension.kind.padEnd(28)} ${tension.seedPackage} → ${tension.observedPackage}`
      );
    }
  }
  lines.push("  candidates");
  for (const item of analysis.candidates) {
    const { participation } = item;
    lines.push(
      `    ${item.package.padEnd(30)} ${item.dimensions.join(", ")}${item.roles.length > 0 ? ` · ${item.roles.join(", ")}` : ""}`
    );
    lines.push(
      `      ${participation.representations} representations · ${participation.implementations} implementations · ${participation.references} references · ${participation.behaviors} behaviors${participation.conversions > 0 ? ` · ${participation.conversions} conversions` : ""}`
    );
  }
  const behavior = analysis.behavior.byPackage.filter(
    (row) => row.package !== seed || row.contract + row.implementation > 0
  );
  if (behavior.length > 0) {
    lines.push("  behavior");
    for (const row of behavior) {
      const kinds = Object.entries(row.kinds)
        .map(
          ([kind, counts]) =>
            `${kind} ${counts.contract}/${counts.implementation}`
        )
        .join(", ");
      lines.push(
        `    ${row.package.padEnd(30)} ${row.contract} contract · ${row.implementation} implementation · ${row.functions} functions · ${row.methods} methods · ${row.constructors} constructors · by file kind: ${kinds}`
      );
    }
  }
  const mixedKinds = analysis.representationKinds.filter((row) =>
    Object.keys(row.kinds).some((kind) => kind !== "source")
  );
  if (mixedKinds.length > 0) {
    lines.push("  representations by file kind");
    for (const row of analysis.representationKinds) {
      lines.push(
        `    ${row.package.padEnd(30)} ${Object.entries(row.kinds)
          .map(([kind, count]) => `${kind} ${count}`)
          .join(" · ")}`
      );
    }
  }
  const evolution = (analysis.evolution ?? []).filter((row) => row.support > 0);
  if (evolution.length > 0) {
    lines.push("  evolution");
    for (const row of evolution) {
      lines.push(
        `    ${row.package.padEnd(30)} ${row.changedRepresentationFiles} changed files · ${row.hotspotRepresentations} hotspot representations · ${row.supportingCouplingPairs}/${row.strongCouplingPairs} supporting coupling pairs · ${plural(row.commits, "commit")}`
      );
      for (const hotspot of row.hotspots) {
        lines.push(
          `      hotspot ${hotspot.file} · ${plural(hotspot.commits, "commit")} · p${Math.round(hotspot.commitPercentile * 100)}`
        );
      }
      for (const coupling of row.couplings.slice(0, 3)) {
        lines.push(
          `      ${coupling.context}${coupling.aggregatorMediated ? " (aggregator-mediated)" : ""} ${coupling.file} ↔ ${coupling.partnerFile} · ${plural(coupling.coChangeCommits, "commit")} · ${percent(coupling.conditional)} / ${percent(coupling.partnerConditional)} · jaccard ${coupling.jaccard.toFixed(2)}`
        );
      }
    }
  }
  for (const caution of analysis.cautions) {
    lines.push(`  caution  ${caution.kind}: ${caution.detail}`);
  }
  const boundaries = analysis.overlap.filter(
    (item) => item.representationBoundary
  );
  if (boundaries.length > 0) {
    lines.push("  representation boundaries");
    for (const item of boundaries) {
      lines.push(
        `    ${item.other.name.padEnd(30)} ${item.other.package} · converters in ${item.conversionPackages.join(", ")}`
      );
      const partner = ownership.concepts.find(
        (concept) => concept.concept.id === item.other.id
      );
      if (partner !== undefined) {
        lines.push(`      ${partner.alignment} · ${centerLine(partner)}`);
      }
    }
  }
}

function renderLocality(
  item: ConceptBehavioralLocality,
  config: AnalysisConfig,
  lines: string[]
): void {
  const { topModules, topExternalCompanions } =
    config.behavioralLocality.report;
  const { behavior, span, traversal, changeSurface, halo, concentration } =
    item;
  lines.push("");
  lines.push("BEHAVIORAL LOCALITY");
  lines.push(
    `  shape              ${[item.shape.primary, ...item.shape.modifiers].join(" · ")}${item.anchored ? " · seed package anchored" : ""}`
  );
  lines.push(`  source behavior    ${localityLine(item)}`);
  if (behavior.test + behavior.story + behavior.other > 0) {
    lines.push(
      `  other behavior     ${behavior.test} test · ${behavior.story} story · ${behavior.other} other (${plural(span.moduleCount, "module")} · ${plural(span.packageCount, "package")} in all)`
    );
  }
  if (concentration.primaryPackage !== undefined) {
    lines.push(
      `  concentration      ${concentration.primaryPackage} ${percent(concentration.primaryPackageShare ?? 0)} of source behavior${concentration.primaryModule === undefined ? "" : ` · ${concentration.primaryModule} ${percent(concentration.primaryModuleShare ?? 0)}`}`
    );
  }
  if (behavior.byPackage.length > 0) {
    lines.push("  by package");
    for (const row of behavior.byPackage) {
      lines.push(
        `    ${row.package.padEnd(30)} ${plural(row.behaviors, "behavior")} · ${plural(row.modules, "module")} · ${row.contractBehaviors} contract · ${row.implementationBehaviors} implementation · ${row.conversionBehaviors} conversion · source ${row.sourceBehaviors} · test ${row.testBehaviors} · story ${row.storyBehaviors}`
      );
    }
  }
  const modules = [...behavior.byModule].sort(
    (a, b) =>
      Number(b.kind === "source") - Number(a.kind === "source") ||
      b.behaviors - a.behaviors ||
      a.module.localeCompare(b.module)
  );
  if (modules.length > 0) {
    lines.push("  modules");
    for (const row of modules.slice(0, topModules)) {
      lines.push(
        `    ${row.module.padEnd(60)} ${row.kind} · ${plural(row.behaviors, "behavior")} · ${row.contractBehaviors}/${row.implementationBehaviors}/${row.conversionBehaviors} contract/implementation/conversion${row.role === undefined ? "" : ` · ${row.role}`}`
      );
    }
    if (modules.length > topModules) {
      lines.push(`    … ${modules.length - topModules} more (see --json)`);
    }
  }
  lines.push("  traversal");
  lines.push(
    `    semantic center ${traversal.origin.package} · ${traversal.origin.module}`
  );
  for (const distance of traversal.centerDistances) {
    lines.push(`    ${distanceLine(distance)}`);
  }
  const apart = traversal.packageDistances.filter(
    (distance) =>
      distance.outward === undefined && distance.inward === undefined
  );
  for (const distance of apart) {
    lines.push(`    ${distanceLine(distance)}`);
  }
  if (traversal.moduleDistances.length > 0) {
    lines.push(
      `    from the seed module: max distance ${traversal.maxModuleDistance ?? "—"} · ${traversal.disconnectedModules} disconnected`
    );
    for (const distance of traversal.moduleDistances.slice(0, topModules)) {
      lines.push(`      ${distanceLine(distance)}`);
    }
    if (traversal.moduleDistances.length > topModules) {
      lines.push(
        `      … ${traversal.moduleDistances.length - topModules} more (see --json)`
      );
    }
  }
  if (span.boundaryEdges.length > 0) {
    lines.push(
      `    boundary edges ${span.boundaryEdges.map((edge) => `${edge.from} → ${edge.to}`).join(" · ")}`
    );
  }
  lines.push(
    `  change surface     ${plural(changeSurface.sourceModules, "source module")} · ${plural(changeSurface.packages, "package")} · ${changeSurface.implementationModules} implementation · ${changeSurface.converterModules} converter · ${changeSurface.hotspotModules} hotspot · ${changeSurface.stronglyCoupledBehaviorModules} strongly coupled`
  );
  lines.push(
    `  reference halo     ${plural(halo.packages, "package")} · ${plural(halo.modules, "module")} · ${plural(halo.references, "reference")}`
  );
  const { representation, usage } = item.distribution;
  if (representation.package !== undefined || usage.package !== undefined) {
    lines.push(
      `  distribution       representations ${representation.package ?? "—"} ${percent(representation.share ?? 0)} · references ${usage.package ?? "—"} ${percent(usage.share ?? 0)}`
    );
  }
  const temporal = item.temporal;
  if (
    temporal !== undefined &&
    temporal.hotspots.length +
      temporal.internalCouplings.length +
      temporal.externalCompanions.length >
      0
  ) {
    lines.push("  temporal");
    for (const hotspot of temporal.hotspots) {
      lines.push(
        `    hotspot ${hotspot.module} · ${plural(hotspot.commits, "commit")} · p${Math.round(hotspot.commitPercentile * 100)}`
      );
    }
    for (const pair of temporal.internalCouplings) {
      lines.push(
        `    ${pair.left} ↔ ${pair.right} · ${plural(pair.coChangeCommits, "commit")} · ${percent(pair.leftConditional)} / ${percent(pair.rightConditional)} · ${pair.context}${pair.aggregatorMediated ? " (aggregator-mediated)" : ""} · static ${pair.staticPath}`
      );
    }
    for (const companion of temporal.externalCompanions.slice(
      0,
      topExternalCompanions
    )) {
      lines.push(
        `    companion ${companion.module} ↔ ${companion.external} (${companion.externalPackage}) · ${plural(companion.coChangeCommits, "commit")} · ${companion.context}`
      );
    }
    if (temporal.externalCompanions.length > topExternalCompanions) {
      lines.push(
        `    … ${temporal.externalCompanions.length - topExternalCompanions} more companions (see --json)`
      );
    }
  }
  for (const caution of item.cautions) {
    lines.push(`  caution  ${caution.kind}: ${caution.detail}`);
  }
}

export function renderConceptFamily(
  family: ConceptFamily,
  config: AnalysisConfig = ANALYSIS_CONFIG,
  overlap?: ConceptOverlapReport,
  ownership?: ConceptOwnershipReport,
  locality?: ConceptBehavioralLocalityReport
): string {
  const { topRepresentations, evidenceShown } = config.concepts.report;
  const { seed, distribution } = family;
  const lines: string[] = [];
  lines.push(`CONCEPT ${seed.name}`);
  lines.push("═".repeat(8 + seed.name.length));
  lines.push(`Kind         ${seed.kind}`);
  lines.push(`Declared in  ${seed.declaration.package}`);
  lines.push(`File         ${seed.declaration.file}`);
  lines.push(
    `Surface      ${seed.surface.packagePublic ? "package-public" : seed.surface.moduleExported ? "module export" : "internal"}${seed.surface.externallyUsed ? " · used externally" : ""}`
  );

  lines.push("");
  lines.push("REPRESENTATIONS");
  if (family.representations.length === 0) {
    lines.push("  none");
  }
  for (const [relationship, label] of Object.entries(REPRESENTATION_LABELS)) {
    const items = family.representations.filter(
      (item) => item.relationship === relationship
    );
    if (items.length === 0) {
      continue;
    }
    lines.push(`  ${label} (${items.length})`);
    representationLines(items, topRepresentations, lines);
  }

  lines.push("");
  lines.push("RELATIONSHIPS");
  for (const [kind, count] of Object.entries(family.relationships)) {
    if (count > 0) {
      lines.push(`  ${kind.padEnd(16)} ${count}`);
    }
  }
  if (distribution.references === 0) {
    lines.push("  none");
  }

  lines.push("");
  lines.push("DISTRIBUTION");
  lines.push(
    `  ${plural(distribution.packageCount, "package")} · ${plural(distribution.moduleCount, "module")} · ${plural(distribution.references, "structural reference")}`
  );
  lines.push(
    `  ${distribution.packagePublicRepresentations} package-public representations in target`
  );
  const analysis = family.distributionAnalysis;
  if (analysis === undefined) {
    lines.push("  packages");
    for (const name of distribution.packages) {
      lines.push(`    ${name}`);
    }
    lines.push("  modules");
    for (const name of distribution.modules) {
      lines.push(`    ${name}`);
    }
  } else {
    renderFamilyDistribution(analysis, config, lines);
  }

  if (overlap !== undefined) {
    const mine = overlap.candidates.filter(
      (candidate) =>
        candidate.left.id === seed.id || candidate.right.id === seed.id
    );
    lines.push("");
    lines.push("OVERLAP CANDIDATES");
    if (mine.length === 0) {
      lines.push("  none");
    }
    for (const candidate of mine.slice(
      0,
      config.conceptOverlap.report.topCandidates
    )) {
      const other =
        candidate.left.id === seed.id ? candidate.right : candidate.left;
      lines.push(
        `  ${other.name.padEnd(32)} ${other.package}${candidate.crossPackage ? " · cross-package" : ""}`
      );
      lines.push(`    ${candidate.shapes.join(" · ")}`);
      const detail = overlapLine(candidate);
      if (detail !== "") {
        lines.push(`    ${detail}`);
      }
    }
    if (mine.length > config.conceptOverlap.report.topCandidates) {
      lines.push(
        `  … ${mine.length - config.conceptOverlap.report.topCandidates} more (see --json)`
      );
    }
  }

  const ownershipAnalysis = ownership?.concepts.find(
    (item) => item.concept.id === seed.id
  );
  if (ownership !== undefined && ownershipAnalysis !== undefined) {
    renderOwnership(ownershipAnalysis, ownership, lines);
  }
  const localityAnalysis = locality?.concepts.find(
    (item) => item.concept.id === seed.id
  );
  if (localityAnalysis !== undefined) {
    renderLocality(localityAnalysis, config, lines);
  }

  lines.push("");
  lines.push("EVIDENCE");
  for (const item of family.evidence.slice(0, evidenceShown)) {
    const source = item.source ? ` ${item.source.name}` : "";
    lines.push(
      `  ${item.kind.padEnd(16)}${source.padEnd(33)} ${item.file}:${item.line}`
    );
  }
  const remaining = family.evidence.length - evidenceShown;
  if (remaining > 0) {
    lines.push(`  … ${remaining} more (see --json)`);
  }
  return lines.join("\n");
}

function renderFamilyDistribution(
  analysis: ConceptDistributionAnalysis,
  config: AnalysisConfig,
  lines: string[]
): void {
  const { topPackages, topModules } = config.conceptDistribution.report;
  const { representations, references, boundaries, temporal } = analysis;
  lines.push(`  shapes         ${analysis.shapes.join(" · ")}`);
  lines.push(`  package span   ${boundaries.packageSpan}`);
  lines.push(`  seed package   ${boundaries.seedPackage}`);
  if (representations.primaryPackage !== undefined) {
    lines.push(
      `  representations  ${representations.total} · ${representations.primaryPackage} ${percent(representations.primaryShare ?? 0)} · ${plural(representations.packageCount, "package")} · ${plural(representations.moduleCount, "module")}`
    );
  }
  if (references.primaryPackage !== undefined) {
    lines.push(
      `  references       ${references.total} · ${references.primaryPackage} ${percent(references.primaryShare ?? 0)} · ${plural(references.packageCount, "package")}`
    );
  }

  if (representations.implementationPackages > 0) {
    lines.push("");
    lines.push("IMPLEMENTATIONS");
    lines.push(
      `  ${plural(representations.implementationPackages, "package")} · ${plural(representations.implementationModules, "module")}`
    );
  }

  lines.push("");
  lines.push("REFERENCES BY PACKAGE");
  if (references.byPackage.length === 0) {
    lines.push("  none");
  }
  for (const entry of references.byPackage.slice(0, topPackages)) {
    lines.push(
      `  ${entry.package.padEnd(32)} ${String(entry.references).padStart(5)}  ${percent(entry.share).padStart(6)}  ${plural(entry.modules, "module")}`
    );
  }
  if (references.byPackage.length > topPackages) {
    lines.push(`  … ${references.byPackage.length - topPackages} more`);
  }
  if (references.byModule.length > 0) {
    lines.push("REFERENCES BY MODULE");
    for (const entry of references.byModule.slice(0, topModules)) {
      lines.push(
        `  ${String(entry.references).padStart(5)}  ${percent(entry.share).padStart(6)}  ${entry.module}`
      );
    }
    if (references.byModule.length > topModules) {
      lines.push(`  … ${references.byModule.length - topModules} more`);
    }
  }

  if (analysis.relationships.byKind.length > 0) {
    lines.push("");
    lines.push("RELATIONSHIPS BY PACKAGE");
    for (const kind of analysis.relationships.byKind) {
      lines.push(`  ${kind.relationship} (${kind.total})`);
      for (const entry of kind.packages.slice(0, topPackages)) {
        lines.push(`    ${entry.package.padEnd(32)} ${entry.count}`);
      }
    }
  }

  lines.push("");
  lines.push("PACKAGE DISTRIBUTION");
  for (const row of analysis.packages) {
    lines.push(`  ${row.package}`);
    lines.push(`    seed               ${row.seed ? "yes" : "no"}`);
    lines.push(
      `    representations    ${String(row.representations).padStart(3)}`
    );
    lines.push(
      `    implementations    ${String(row.implementations).padStart(3)}`
    );
    lines.push(`    references         ${String(row.references).padStart(3)}`);
    if (row.relationshipKinds.length > 0) {
      lines.push(`    relationships      ${row.relationshipKinds.join(", ")}`);
    }
  }

  if (temporal !== undefined) {
    lines.push("");
    lines.push("TEMPORAL");
    lines.push(
      `  ${plural(temporal.representedFilesWithChurn, "representation file")} with churn in target`
    );
    if (temporal.hotspotRepresentations.length > 0) {
      lines.push(`  hotspots  ${temporal.hotspotRepresentations.join(", ")}`);
    }
    if (temporal.strongMemberCouplings.length === 0) {
      lines.push("  no strong co-change between member files");
    }
    for (const coupling of temporal.strongMemberCouplings) {
      lines.push(`  ${couplingLine(coupling)}`);
    }
  }
}

function renderEvolutionSummary(report: SurfaceReport, lines: string[]): void {
  const evolution = report.evolutionaryPressure;
  if (!evolution.available) {
    return;
  }
  lines.push("");
  lines.push("EVOLUTIONARY PRESSURE");
  if (evolution.historicalSupport === "insufficient") {
    lines.push(
      `  insufficient history (${plural(evolution.support.eligibleRadiusCommits, "eligible commit")})`
    );
    return;
  }
  if (evolution.reinforced.length === 0 && evolution.tensions.length === 0) {
    lines.push("  no reinforced static pressure under current policy");
  }
  if (evolution.reinforced.length > 0) {
    lines.push("  reinforced");
    for (const signal of evolution.reinforced) {
      lines.push(`    ${signal.staticSignal}`);
    }
  }
  if (evolution.tensions.length > 0) {
    lines.push("  tensions");
    for (const kind of new Set(evolution.tensions.map((t) => t.kind))) {
      lines.push(`    ${kind}`);
    }
  }
  lines.push("  history");
  lines.push(
    `    ${plural(evolution.support.eligibleRadiusCommits, "eligible commit")}`
  );
}

function evolutionValue(item: EvolutionaryEvidence): string {
  if (typeof item.value === "boolean") {
    return item.value ? "yes" : "no";
  }
  if (typeof item.value !== "number") {
    return item.value;
  }
  if (/rate|percentile|conditional|jaccard/i.test(item.metric)) {
    return percent(item.value);
  }
  return count(item.value);
}

/** Evidence lines grouped by subject; target-wide items come first, unlabeled. */
function evolutionEvidenceLines(
  evidence: EvolutionaryEvidence[],
  lines: string[],
  indent: string
): void {
  let subject: string | undefined;
  for (const item of evidence) {
    if (item.subject !== subject) {
      subject = item.subject;
      if (subject !== undefined) {
        lines.push(`${indent}${subject}`);
      }
    }
    const pad = item.subject === undefined ? indent : `${indent}  `;
    lines.push(
      `${pad}${metricLabel(item.metric).padEnd(26)} ${evolutionValue(item)}`
    );
  }
}

function renderTension(tension: ArchitecturalTension, lines: string[]): void {
  lines.push("");
  lines.push(`  ${tension.kind.replace(/-/g, " ").toUpperCase()}`);
  lines.push(`    ${tension.summary}`);
  lines.push(`    support ${plural(tension.support.commits, "commit")}`);
  lines.push("");
  lines.push("    static");
  for (const item of tension.evidence.static) {
    lines.push(pressureEvidenceLine(item, "      "));
  }
  lines.push("");
  lines.push("    historical");
  evolutionEvidenceLines(tension.evidence.evolutionary, lines, "      ");
}

/**
 * Focused static × evolutionary view: which V5.3 pressures history
 * reinforces, which remain static-only, where the two disagree, plus the
 * hub and static-path evidence behind them. No score, no recommendation.
 */
export function renderEvolution(
  report: Pick<
    SurfaceReport,
    | "target"
    | "structuralPressure"
    | "architecturalProfile"
    | "evolutionaryPressure"
  >,
  config: AnalysisConfig = ANALYSIS_CONFIG
): string {
  const evolution = report.evolutionaryPressure;
  const lines: string[] = [];
  lines.push("EVOLUTIONARY PRESSURE");
  lines.push("═".repeat(21));
  lines.push(`Target  ${report.target.name ?? report.target.path}`);
  if (!evolution.available) {
    lines.push("");
    lines.push(
      `Evolutionary pressure unavailable: ${evolution.reason.replace(/-/g, " ")}`
    );
    lines.push("");
    return lines.join("\n");
  }
  const { support, spread } = evolution;
  lines.push("");
  lines.push("STATIC");
  const staticLines = [
    ...report.structuralPressure.signals.map((signal) => signal.kind),
    ...report.architecturalProfile.target.signals.map(
      (signal) => signal.signal
    ),
  ];
  if (staticLines.length === 0) {
    lines.push("  no pressure or profile signals");
  }
  for (const line of staticLines) {
    lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push("EVOLUTION");
  lines.push(
    `  ${plural(support.eligibleRadiusCommits, "eligible commit")} · historical support ${evolution.historicalSupport}`
  );
  lines.push(
    `  ${percent(spread.crossPackageRate)} cross-package · ${percent(spread.boundaryCrossingRate)} boundary-crossing · ${percent(spread.edgeLessSpreadRate)} edge-less spread (${plural(spread.edgeLessSpreadCommits, "commit")})`
  );
  lines.push(
    `  ${plural(support.hotspots, "hotspot")} · ${plural(support.packageCouplingPairs, "package pair")} · ${plural(support.fileCouplingPairs, "file pair")}`
  );

  if (evolution.reinforced.length > 0) {
    lines.push("");
    lines.push("REINFORCED");
    for (const signal of evolution.reinforced) {
      lines.push("");
      lines.push(`  ${signal.staticSignal.replace(/-/g, " ").toUpperCase()}`);
      lines.push("");
      lines.push("    static");
      for (const item of signal.staticEvidence) {
        lines.push(pressureEvidenceLine(item, "      "));
      }
      lines.push("");
      lines.push("    historical");
      evolutionEvidenceLines(signal.evolutionaryEvidence, lines, "      ");
      if (signal.intent.anchored) {
        lines.push("");
        lines.push(
          `    anchored${signal.intent.anchorReason === undefined ? "" : ` — ${signal.intent.anchorReason}`}`
        );
      }
    }
  }

  if (evolution.staticOnly.length > 0) {
    lines.push("");
    lines.push("STATIC-ONLY");
    for (const entry of evolution.staticOnly) {
      lines.push("");
      lines.push(
        `  ${entry.staticSignal.replace(/-/g, " ").toUpperCase()} · ${entry.status.replace(/-/g, " ")}`
      );
      if (entry.evolutionaryEvidence.length > 0) {
        lines.push("");
        lines.push("    historical");
        evolutionEvidenceLines(entry.evolutionaryEvidence, lines, "      ");
      }
    }
  }

  if (evolution.tensions.length > 0) {
    const shown = evolution.tensions.slice(
      0,
      config.evolutionaryPressure.report.topTensions
    );
    lines.push("");
    lines.push(`TENSIONS (${evolution.tensions.length})`);
    for (const tension of shown) {
      renderTension(tension, lines);
    }
    const hidden = evolution.tensions.length - shown.length;
    if (hidden > 0) {
      lines.push("");
      lines.push(`  ${hidden} more in --json`);
    }
  }

  const hubs = evolution.hotStructuralHubs.slice(
    0,
    config.evolutionaryPressure.report.topHubs
  );
  if (hubs.length > 0) {
    lines.push("");
    lines.push("HOT STRUCTURAL HUBS");
    for (const hub of hubs) {
      lines.push("");
      lines.push(`  ${hub.file}`);
      lines.push(
        `    ${plural(hub.commits, "commit")} · ${percent(hub.commitPercentile)} commit percentile · fan-in ${hub.fanIn} · fan-out ${hub.fanOut} · ${plural(hub.functions, "function")}`
      );
    }
  }

  lines.push("");
  return lines.join("\n");
}

function renderCommitRadius(commit: CommitRadius, lines: string[]): void {
  lines.push("");
  lines.push(`  ${commit.hash.slice(0, 7)}  ${commit.timestamp.slice(0, 10)}`);
  lines.push(
    `    files       ${commit.files} (${commit.sourceFiles} source · ${commit.filesByKind.test} test · ${commit.filesByKind.config} config)`
  );
  lines.push(`    packages    ${commit.packages}`);
  lines.push(`    boundaries  ${commit.packageBoundariesCrossed}`);
  lines.push(
    `    target      ${commit.targetFiles} of ${commit.files} files (${percent(commit.targetFileShare)})`
  );
  if (commit.linesChanged !== null) {
    lines.push(`    lines       ${count(commit.linesChanged)}`);
  }
  lines.push("    packages touched");
  for (const pkg of commit.packageSet) {
    lines.push(`      ${pkg}`);
  }
}

/**
 * Focused change-radius view: distributions of files, source files,
 * packages, and static boundaries per target-touching commit; rates; the
 * most common package combinations; the widest commits.
 */
export function renderRadius(
  report: Pick<SurfaceReport, "target" | "changeRadius">,
  config: AnalysisConfig = ANALYSIS_CONFIG
): string {
  const radius = report.changeRadius;
  const lines: string[] = [];
  lines.push("CHANGE RADIUS");
  lines.push("═".repeat(13));
  lines.push(`Target  ${report.target.name ?? report.target.path}`);
  if (!radius.available) {
    lines.push("");
    lines.push(
      `Change radius unavailable: ${radius.reason.replace(/-/g, " ")}`
    );
    lines.push("");
    return lines.join("\n");
  }
  const { history, summary } = radius;
  lines.push(`Window  ${windowLabel(history.windowDays)}`);
  lines.push("");
  lines.push("COMMITS");
  lines.push(`  ${history.commitsObserved} observed touching the target`);
  lines.push(`  ${history.commitsEligible} eligible`);
  lines.push(
    `  ${history.commitsExcluded} excluded as oversized (> ${history.oversized.maxCodeFilesPerCommit} code files, or a config sweep over ≥ ${history.oversized.configSweepMinPackages} packages)`
  );
  lines.push("");
  lines.push("DISTRIBUTION");
  lines.push(churnDistributionLine("Files / commit", summary.files));
  lines.push(
    churnDistributionLine("Source files / commit", summary.sourceFiles)
  );
  lines.push(churnDistributionLine("Packages / commit", summary.packages));
  lines.push(churnDistributionLine("Boundaries / commit", summary.boundaries));
  lines.push("");
  lines.push("RATES");
  lines.push(
    `  Cross-package commits      ${summary.crossPackageCommits} / ${summary.commits} · ${percent(summary.crossPackageRate)}`
  );
  lines.push(
    `  Boundary-crossing commits  ${summary.boundaryCrossingCommits} / ${summary.commits} · ${percent(summary.boundaryCrossingRate)}`
  );
  if (summary.packageCombinations.length > 0) {
    lines.push("");
    lines.push("MOST COMMON PACKAGE COMBINATIONS");
    for (const combination of summary.packageCombinations) {
      lines.push("");
      lines.push(`  ${combination.packages.join(" + ")}`);
      lines.push(`    ${plural(combination.commits, "commit")}`);
    }
  }
  const widest = radius.commits.slice(0, config.changeRadius.report.topCommits);
  if (widest.length > 0) {
    lines.push("");
    lines.push("WIDEST COMMITS");
    for (const commit of widest) {
      renderCommitRadius(commit, lines);
    }
  }
  lines.push("");
  return lines.join("\n");
}

const RELATION_LABELS: Record<ChangeCouplingPair["staticRelation"], string> = {
  bidirectional: "bidirectional",
  "left-to-right": "left → right",
  none: "none",
  "right-to-left": "right → left",
  unmeasured: "unmeasured (not a graph module)",
};

function renderPair(
  pair: ChangeCouplingPair | FileChangeCouplingPair,
  lines: string[]
): void {
  lines.push("");
  lines.push(`  ${pair.left}`);
  lines.push(`  ↔ ${pair.right}`);
  lines.push("");
  lines.push(`    co-change commits      ${pair.coChangeCommits}`);
  lines.push(
    `    left commits           ${pair.leftCommits} · right commits ${pair.rightCommits}`
  );
  lines.push(
    `    left → right           ${percent(pair.leftConditional)}  (left's changes that included right)`
  );
  lines.push(
    `    right → left           ${percent(pair.rightConditional)}  (right's changes that included left)`
  );
  lines.push(`    Jaccard                ${percent(pair.jaccard)}`);
  lines.push(
    `    static relation        ${RELATION_LABELS[pair.staticRelation]}`
  );
  lines.push(`    static path            ${pair.staticPath}`);
  if ("context" in pair) {
    lines.push(`    context                ${pair.context}`);
  }
}

/**
 * Focused change-coupling view: strongest file pairs, cross-package pairs,
 * pairs with no static edge, and package pairs. Left/right are lexical;
 * each direction's conditional is shown so 100% never hides 1-of-1.
 */
export function renderCoupling(
  report: Pick<SurfaceReport, "target" | "changeCoupling">,
  config: AnalysisConfig = ANALYSIS_CONFIG
): string {
  const coupling = report.changeCoupling;
  const lines: string[] = [];
  lines.push("CHANGE COUPLING");
  lines.push("═".repeat(15));
  lines.push(`Target  ${report.target.name ?? report.target.path}`);
  if (!coupling.available) {
    lines.push("");
    lines.push(
      `Change coupling unavailable: ${coupling.reason.replace(/-/g, " ")}`
    );
    lines.push("");
    return lines.join("\n");
  }
  const { history, summary, filePairs, packagePairs } = coupling;
  lines.push(`Window  ${windowLabel(history.windowDays)}`);
  lines.push("");
  lines.push("COMMITS");
  lines.push(`  ${history.commitsConsidered} considered`);
  lines.push(
    `  ${history.commitsExcluded} excluded as oversized (> ${history.oversized.maxCodeFilesPerCommit} code files, or a config sweep over ≥ ${history.oversized.configSweepMinPackages} packages)`
  );
  lines.push(
    `  ${count(history.observedFilePairs)} file pairs observed repository-wide`
  );
  lines.push("");
  lines.push("PAIRS");
  lines.push(
    `  ${plural(summary.filePairs, "strong file relationship")} · ${summary.samePackagePairs} same-package · ${summary.crossPackagePairs} cross-package`
  );
  lines.push(
    `  ${summary.filePairsWithoutStaticEdge} without static edge · ${plural(summary.packagePairs, "package relationship")}`
  );

  const limit = config.changeCoupling.report.topPairs;
  const sections: [string, ChangeCouplingPair[]][] = [
    ["STRONGEST FILE COUPLING", filePairs.slice(0, limit)],
    [
      "CROSS-PACKAGE COUPLING",
      filePairs.filter((p) => p.scope === "cross-package").slice(0, limit),
    ],
    [
      "TEMPORALLY COUPLED WITHOUT STATIC EDGE",
      filePairs.filter((p) => p.staticRelation === "none").slice(0, limit),
    ],
    ["PACKAGE COUPLING", packagePairs.slice(0, limit)],
  ];
  for (const [title, pairs] of sections) {
    if (pairs.length === 0) {
      continue;
    }
    lines.push("");
    lines.push(title);
    for (const pair of pairs) {
      renderPair(pair, lines);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function renderHotspot(hotspot: FileHotspot, lines: string[]): void {
  const { evolution, complexity, architecture } = hotspot;
  lines.push("");
  lines.push(`  ${hotspot.file}`);
  lines.push("");
  lines.push("    Evolution");
  lines.push(`      ${plural(evolution.commits, "commit")}`);
  lines.push(
    `      commit percentile ${percent(evolution.commitPercentile)} (repository, same kind)`
  );
  lines.push(
    `      ${count(evolution.linesChanged)} lines changed · line churn percentile ${percent(evolution.lineChurnPercentile)}`
  );
  lines.push(`      last changed ${ago(evolution.daysSinceLastChange)}`);
  lines.push("");
  lines.push("    Complexity");
  lines.push(
    `      ${plural(complexity.functions, "function")} · complexity percentile ${percent(hotspot.rank.complexityPercentile)} (target)`
  );
  lines.push(
    `      control-flow decisions  max ${complexity.controlFlowDecisions.max} · total ${complexity.controlFlowDecisions.total}`
  );
  lines.push(
    `      expression decisions    max ${complexity.expressionDecisions.max} · total ${complexity.expressionDecisions.total}`
  );
  lines.push(`      nesting                 max ${complexity.nesting.max}`);
  lines.push(
    `      statements              max ${complexity.statements.max} · total ${complexity.statements.total}`
  );
  const gravity = architecture?.moduleGravity;
  if (gravity !== undefined) {
    lines.push("");
    lines.push("    Architecture");
    lines.push(`      fan-in ${gravity.fanIn} · fan-out ${gravity.fanOut}`);
    lines.push(
      `      transitive dependents ${gravity.transitiveDependents} · dependencies ${gravity.transitiveDependencies}`
    );
  }
  lines.push("");
  lines.push("    Signals");
  for (const signal of hotspot.signals) {
    lines.push(`      ${signal}`);
  }
}

/**
 * Focused hotspot view: population, counts, and each qualifying file's
 * evolution / complexity / architecture vectors with the signals that held.
 */
export function renderHotspots(
  report: Pick<SurfaceReport, "target" | "hotspots">,
  config: AnalysisConfig = ANALYSIS_CONFIG
): string {
  const { hotspots } = report;
  const lines: string[] = [];
  lines.push("HOTSPOTS");
  lines.push("═".repeat(8));
  lines.push(`Target  ${report.target.name ?? report.target.path}`);
  if (!hotspots.available) {
    lines.push("");
    lines.push(
      `Hotspot analysis unavailable: ${hotspots.reason.replace(/-/g, " ")}`
    );
    lines.push("");
    return lines.join("\n");
  }
  const { summary } = hotspots;
  lines.push(`Window  ${windowLabel(hotspots.windowDays)}`);
  lines.push("");
  lines.push(`Eligible source files  ${summary.eligibleSourceFiles}`);
  lines.push(
    `Above commit p90       ${summary.filesAboveCommitP90} · above p95 ${summary.filesAboveCommitP95}`
  );
  lines.push(
    `Hotspots               ${summary.hotspots}${summary.hotspots > 0 ? ` (${percent(summary.hotspotShare)} of eligible)` : ""}`
  );
  const shown = hotspots.files.slice(0, config.hotspots.report.topFiles);
  for (const hotspot of shown) {
    renderHotspot(hotspot, lines);
  }
  const remaining = hotspots.files.length - shown.length;
  if (remaining > 0) {
    lines.push("");
    lines.push(`  … ${plural(remaining, "more hotspot")}`);
  }
  lines.push("");
  return lines.join("\n");
}

function churnDistributionLine(
  label: string,
  { p50, p90, p95, max }: MetricDistribution
): string {
  return `  ${label.padEnd(24)}p50 ${count(p50)} · p90 ${count(p90)} · p95 ${count(p95)} · max ${count(max)}`;
}

function topFilesBy(
  files: FileChurn[],
  metric: (file: FileChurn) => number,
  limit: number,
  direction: "highest" | "lowest" = "highest"
): FileChurn[] {
  const sign = direction === "highest" ? -1 : 1;
  return files
    .filter((file) => file.commits > 0)
    .sort(
      (a, b) => sign * (metric(a) - metric(b)) || a.file.localeCompare(b.file)
    )
    .slice(0, limit);
}

const KIND_LABELS: Record<ChurnFileKind, string> = {
  config: "Config",
  other: "Other",
  source: "Source",
  story: "Story",
  test: "Test",
};

/**
 * Focused churn view: window, package totals, per-file distributions, and
 * factual rankings. "MOST" means highest measured count — no hotspot, no
 * score, no combination with static structure.
 */
export function renderChurn(
  report: Pick<SurfaceReport, "target" | "churn">,
  config: AnalysisConfig = ANALYSIS_CONFIG
): string {
  const { churn } = report;
  const lines: string[] = [];
  lines.push("CHURN");
  lines.push("═".repeat(5));
  lines.push(`Target  ${report.target.name ?? report.target.path}`);
  if (!churn.available) {
    lines.push("");
    lines.push(
      `Churn analysis unavailable: ${churn.reason.replace(/-/g, " ")}`
    );
    lines.push("");
    return lines.join("\n");
  }
  const { history, summary, distributions, files, target } = churn;
  lines.push("");
  lines.push("WINDOW");
  lines.push(`  ${windowLabel(history.windowDays)}`);
  lines.push(
    `  ${plural(history.commitsAnalyzed, "commit")} in repository window`
  );
  if (!history.historyComplete) {
    lines.push("  shallow clone — history is incomplete");
  }
  lines.push("");
  lines.push("PACKAGE");
  const rows: [string, string][] = [
    ["files", count(summary.filesAnalyzed)],
    ["commits", count(summary.commits)],
    ["additions", count(summary.additions)],
    ["deletions", count(summary.deletions)],
    ["lines changed", count(summary.linesChanged)],
    ["authors", count(summary.authors)],
    ["last changed", ago(target.daysSinceLastChange)],
    ["deleted files", count(summary.deletedFiles)],
  ];
  for (const [label, value] of rows) {
    lines.push(`  ${label.padEnd(16)}${value}`);
  }
  lines.push("");
  lines.push("BY KIND");
  for (const kind of Object.keys(KIND_LABELS) as ChurnFileKind[]) {
    const totals = summary.byKind[kind];
    if (totals.files === 0) {
      continue;
    }
    const share =
      summary.linesChanged === 0
        ? 0
        : totals.linesChanged / summary.linesChanged;
    lines.push(
      `  ${KIND_LABELS[kind].padEnd(8)}${plural(totals.files, "file").padEnd(12)}${plural(totals.commits, "commit").padEnd(14)}${percent(share)} of line churn`
    );
  }
  lines.push("");
  lines.push("DISTRIBUTION");
  lines.push(
    churnDistributionLine("Commits / file", distributions.commitsPerFile)
  );
  lines.push(
    churnDistributionLine(
      "Lines changed / file",
      distributions.linesChangedPerFile
    )
  );
  lines.push(
    churnDistributionLine(
      "Days since change",
      distributions.daysSinceLastChange
    )
  );
  lines.push(
    churnDistributionLine("Authors / file", distributions.authorsPerFile)
  );

  const limit = config.churn.report.topFiles;
  const sections: [string, FileChurn[]][] = [
    ["MOST FREQUENTLY CHANGED", topFilesBy(files, (f) => f.commits, limit)],
    ["MOST LINE CHURN", topFilesBy(files, (f) => f.linesChanged, limit)],
    [
      "MOST RECENTLY CHANGED",
      topFilesBy(files, (f) => f.daysSinceLastChange ?? 0, limit, "lowest"),
    ],
    ["MOST AUTHORS", topFilesBy(files, (f) => f.authors, limit)],
  ];
  for (const [title, top] of sections) {
    if (top.length === 0) {
      continue;
    }
    lines.push("");
    lines.push(title);
    for (const file of top) {
      lines.push("");
      lines.push(`  ${file.file}`);
      lines.push(
        `    ${plural(file.commits, "commit")} · ${count(file.linesChanged)} lines changed · ${plural(file.authors, "author")}`
      );
      lines.push(
        `    last changed ${ago(file.daysSinceLastChange)}${file.ownership === undefined ? "" : ` · primary author share ${percent(file.ownership.primaryAuthorShare)}`}`
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

const DIMENSION_LABELS: Record<PressureDimension, string> = {
  boundary: "Boundary interaction",
  complexity: "Local complexity",
  consumption: "Consumption",
  gravity: "Gravity",
  surface: "Surface",
};

function pressureEvidenceLine(evidence: PressureEvidence, indent: string) {
  return `${indent}${metricLabel(evidence.metric).padEnd(26)} ${profileEvidenceValue(evidence)}`;
}

function pressureEvidenceByDimension(
  evidence: PressureEvidence[],
  lines: string[]
): void {
  let current: PressureDimension | undefined;
  for (const item of evidence) {
    if (item.dimension !== current) {
      current = item.dimension;
      lines.push("");
      lines.push(`  ${DIMENSION_LABELS[current]}`);
    }
    lines.push(pressureEvidenceLine(item, "    "));
  }
}

/**
 * Focused structural-pressure view: every signal with the raw evidence that
 * fired it, grouped by measurement family. No score, no recommendation.
 */
export function renderPressure(report: SurfaceReport): string {
  const { signals, boundaries } = report.structuralPressure;
  const lines: string[] = [];
  lines.push("STRUCTURAL PRESSURE");
  lines.push("═".repeat(19));
  lines.push(`Target  ${report.target.name ?? report.target.path}`);
  lines.push("");
  lines.push(`Structural pressure signals  ${signals.length}`);
  for (const signal of signals) {
    lines.push(`  ${signal.kind}`);
  }
  lines.push(`Boundary pressure signals    ${boundaries.length}`);

  for (const signal of signals) {
    lines.push("");
    lines.push(signal.kind.replace(/-/g, " ").toUpperCase());
    pressureEvidenceByDimension(signal.evidence, lines);
    const { intent } = signal;
    if (intent.anchored || intent.publishable || intent.designedExports) {
      lines.push("");
      lines.push("  Intent");
      if (intent.anchored) {
        lines.push(
          `    anchored${intent.anchorReason === undefined ? "" : ` — ${intent.anchorReason}`}`
        );
      }
      if (intent.publishable === true) {
        lines.push("    publishable");
      }
      if (intent.designedExports === true) {
        lines.push("    designed exports");
      }
    }
  }

  if (boundaries.length > 0) {
    lines.push("");
    lines.push("BOUNDARY PRESSURE");
    for (const boundary of boundaries) {
      lines.push("");
      lines.push(`  ${boundary.from} → ${boundary.to}`);
      lines.push("");
      lines.push(`    ${"shape".padEnd(26)} ${boundary.shape}`);
      for (const item of boundary.evidence) {
        lines.push(pressureEvidenceLine(item, "    "));
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

function contributionLine(contribution: BoundaryModuleContribution): string {
  return `    ${contribution.module.padEnd(44)} ${plural(contribution.importSites, "import site")} · ${percent(contribution.share)} · ${plural(contribution.moduleEdges, "edge")}`;
}

function renderBoundary(
  boundary: BoundaryInteraction,
  count: number,
  lines: string[]
): void {
  const { symbols, usage } = boundary;
  lines.push("");
  lines.push(`${boundary.from} → ${boundary.to}`);
  lines.push(`  module edges       ${boundary.moduleEdges}`);
  lines.push(`  import sites       ${boundary.importSites}`);
  lines.push(
    `  symbols            ${symbols.distinct} · ${usage.typeOnlySymbols} type-only · ${usage.valueOnlySymbols} value-only · ${usage.bothSymbols} both`
  );
  lines.push(
    `  references         ${
      symbols.references === null
        ? "not measured"
        : `${symbols.references}${symbols.referencesPerSymbol === null ? "" : ` · ${symbols.referencesPerSymbol.toFixed(2)} per symbol`}`
    }`
  );
  if (boundary.surfaceCoverage !== null) {
    lines.push(
      `  surface coverage   ${percent(boundary.surfaceCoverage)} · ${symbols.packagePublic ?? 0} package-public consumed`
    );
  }
  lines.push(`  usage              ${usage.namespace}`);
  lines.push(
    `  breadth            ${plural(boundary.breadth.sourceModules, "source module")} · ${plural(boundary.breadth.destinationModules, "destination module")}`
  );
  for (const [title, modules] of [
    ["source modules", boundary.sourceModules],
    ["destination modules", boundary.destinationModules],
  ] as const) {
    if (modules.length === 0) {
      continue;
    }
    lines.push(`  ${title}`);
    for (const contribution of modules.slice(0, count)) {
      lines.push(contributionLine(contribution));
    }
    const remaining = modules.length - count;
    if (remaining > 0) {
      lines.push(`    … ${plural(remaining, "more module")}`);
    }
  }
}

function rankingSection(
  title: string,
  boundaries: BoundaryInteraction[],
  metric: (boundary: BoundaryInteraction) => number | null,
  label: (boundary: BoundaryInteraction) => string,
  count: number,
  lines: string[]
): void {
  const ranked = boundaries
    .flatMap((boundary) => {
      const value = metric(boundary);
      return value === null || value === 0 ? [] : [{ boundary, value }];
    })
    .sort(
      (a, b) =>
        b.value - a.value ||
        `${a.boundary.from} ${a.boundary.to}`.localeCompare(
          `${b.boundary.from} ${b.boundary.to}`
        )
    )
    .slice(0, count);
  if (ranked.length === 0) {
    return;
  }
  lines.push("");
  lines.push(title);
  for (const { boundary } of ranked) {
    lines.push(
      `  ${`${boundary.from} → ${boundary.to}`.padEnd(48)} ${label(boundary)}`
    );
  }
}

/**
 * Focused boundary-interaction view. Rankings are by one measured value
 * each — descriptions of traffic, not judgments about the boundary.
 */
export function renderBoundaries(
  report: SurfaceReport,
  config: AnalysisConfig = ANALYSIS_CONFIG
): string {
  const { incoming, outgoing, summary } = report.boundaryInteractions;
  const gravity = report.dependencyGravity.target;
  const { topBoundaries, topModules } = config.boundaryInteractions.report;
  const lines: string[] = [];
  lines.push("BOUNDARY INTERACTIONS");
  lines.push("═".repeat(21));
  lines.push(`Target  ${report.target.name ?? report.target.path}`);
  lines.push("");
  lines.push("SUMMARY");
  lines.push(totalsLine("incoming", summary.incoming));
  lines.push(totalsLine("outgoing", summary.outgoing));
  lines.push(`  through paths   ${summary.throughPaths}`);
  lines.push(
    `  boundary depth  dependents ${gravity.depth.downstream} · dependencies ${gravity.depth.upstream}`
  );
  lines.push(
    `  gravity         fan-in ${gravity.direct.fanIn} · fan-out ${gravity.direct.fanOut}`
  );

  for (const [title, boundaries] of [
    ["INCOMING", incoming],
    ["OUTGOING", outgoing],
  ] as const) {
    if (boundaries.length === 0) {
      continue;
    }
    lines.push("");
    lines.push(title);
    for (const boundary of boundaries) {
      renderBoundary(boundary, topModules, lines);
    }
  }

  const all = [...incoming, ...outgoing];
  rankingSection(
    "HIGHEST REFERENCE VOLUME",
    incoming,
    (b) => b.symbols.references,
    (b) => plural(b.symbols.references ?? 0, "reference"),
    topBoundaries,
    lines
  );
  rankingSection(
    "MOST SYMBOLS CROSSING",
    all,
    (b) => b.symbols.distinct,
    (b) => plural(b.symbols.distinct, "symbol"),
    topBoundaries,
    lines
  );
  rankingSection(
    "MOST CONCENTRATED DESTINATION",
    all,
    (b) => b.concentration.destinationModuleShare,
    (b) =>
      `${percent(b.concentration.destinationModuleShare)} · ${b.destinationModules[0]?.module ?? ""}`,
    topBoundaries,
    lines
  );
  rankingSection(
    "BROADEST DESTINATION SPREAD",
    all,
    (b) => b.breadth.destinationModules,
    (b) => plural(b.breadth.destinationModules, "destination module"),
    topBoundaries,
    lines
  );
  lines.push("");
  return lines.join("\n");
}

/** "fanIn" → "fan in"; keeps evidence labels readable without a lookup table. */
function metricLabel(metric: string): string {
  return metric.replace(/([A-Z])/g, " $1").toLowerCase();
}

function profileEvidenceValue(evidence: ArchitecturalProfileEvidence): string {
  if (typeof evidence.value !== "number") {
    return `${evidence.value}`;
  }
  if (
    /reach|share|utilization|ratio|concentration|coverage/i.test(
      evidence.metric
    )
  ) {
    return percent(evidence.value);
  }
  return Number.isInteger(evidence.value)
    ? `${evidence.value}`
    : evidence.value.toFixed(2);
}

/**
 * Focused architectural-profile view. Signals are descriptive shapes backed
 * by the evidence shown — never quality judgments or recommendations.
 */
export function renderProfile(report: SurfaceReport): string {
  const { target } = report.architecturalProfile;
  const { gravity, surface, complexity, intent, signals } = target;
  const lines: string[] = [];
  lines.push("ARCHITECTURAL PROFILE");
  lines.push("═".repeat(21));
  lines.push(`Target  ${report.target.name ?? report.target.path}`);
  lines.push("");
  lines.push("SIGNALS");
  if (signals.length === 0) {
    lines.push("  none under current thresholds");
  }
  for (const result of signals) {
    lines.push("");
    lines.push(result.signal.toUpperCase());
    for (const evidence of result.evidence) {
      lines.push(
        `  ${metricLabel(evidence.metric).padEnd(28)} ${profileEvidenceValue(evidence)}`
      );
    }
  }
  lines.push("");
  lines.push("GRAVITY");
  lines.push(`  fan-in ${gravity.fanIn} · fan-out ${gravity.fanOut}`);
  lines.push(
    `  transitive ${gravity.transitiveDependents} dependents · ${gravity.transitiveDependencies} dependencies`
  );
  lines.push(
    `  reach ${percent(gravity.dependentReach)} dependents · ${percent(gravity.dependencyReach)} dependencies`
  );
  lines.push(
    `  depth ${gravity.downstreamDepth} downstream · ${gravity.upstreamDepth} upstream`
  );
  if (gravity.cycleMember) {
    lines.push("  cycle member");
  }
  lines.push("");
  lines.push("SURFACE");
  lines.push(`  package-public   ${surface.packagePublicSymbols}`);
  lines.push(`  externally used  ${surface.externallyUsedSymbols}`);
  lines.push(`  utilization      ${percent(surface.exportUtilization)}`);
  lines.push(`  consumers        ${surface.consumerPackages}`);
  if (surface.primaryConsumerShare !== undefined) {
    lines.push(`  primary share    ${percent(surface.primaryConsumerShare)}`);
  }
  if (
    intent.anchored ||
    intent.publishable !== undefined ||
    intent.designedExports !== undefined
  ) {
    lines.push("");
    lines.push("INTENT");
    if (intent.anchored) {
      lines.push(
        `  anchored${intent.anchorReason === undefined ? "" : ` — ${intent.anchorReason}`}`
      );
    }
    if (intent.publishable === true) {
      lines.push("  publishable");
    }
    if (intent.designedExports === true) {
      lines.push("  designed exports");
    }
  }
  lines.push("");
  lines.push("LOCAL COMPLEXITY");
  lines.push(`  ${plural(complexity.functionsAnalyzed, "function")} analyzed`);
  lines.push(
    `  decisions   p90 ${complexity.decisions.p90} · max ${complexity.decisions.max}`
  );
  lines.push(
    `  nesting     p90 ${complexity.nesting.p90} · max ${complexity.nesting.max}`
  );
  lines.push(
    `  parameters  p90 ${complexity.parameters.p90} · max ${complexity.parameters.max}`
  );
  lines.push(
    `  statements  p90 ${complexity.statements.p90} · max ${complexity.statements.max}`
  );
  lines.push("");
  return lines.join("\n");
}

function gravityModuleLine(gravity: DependencyGravity): string {
  return `fan-in ${gravity.direct.fanIn} · fan-out ${gravity.direct.fanOut}`;
}

function topModulesBy(
  modules: DependencyGravity[],
  metric: (gravity: DependencyGravity) => number,
  count: number
): DependencyGravity[] {
  return modules
    .filter((gravity) => metric(gravity) > 0)
    .sort((a, b) => metric(b) - metric(a) || a.node.id.localeCompare(b.node.id))
    .slice(0, count);
}

function concentrationSection(
  title: string,
  entries: ModuleEdgeConcentration[],
  count: number,
  lines: string[]
): void {
  if (entries.length === 0) {
    return;
  }
  lines.push("");
  lines.push(title);
  for (const entry of entries.slice(0, count)) {
    lines.push(
      `  ${entry.module.padEnd(44)} ${plural(entry.edges, "edge")} · ${percent(entry.share)}`
    );
  }
  const remaining = entries.length - count;
  if (remaining > 0) {
    lines.push(`  … ${plural(remaining, "more module")}`);
  }
}

/**
 * Focused dependency-gravity view. "MOST" / "HIGHEST" / "DEEPEST" / "LARGEST"
 * mean highest measured value — descriptions of graph shape, not judgments.
 */
export function renderGravity(
  report: SurfaceReport,
  config: AnalysisConfig = ANALYSIS_CONFIG
): string {
  const {
    population,
    target,
    modules,
    incomingConcentration,
    outgoingConcentration,
  } = report.dependencyGravity;
  const lines: string[] = [];
  lines.push("DEPENDENCY GRAVITY");
  lines.push("═".repeat(18));
  lines.push(`Target  ${report.target.name ?? report.target.path}`);
  lines.push("");
  lines.push("PACKAGE");
  lines.push(
    `  fan-in                   ${plural(target.direct.fanIn, "package")}`
  );
  lines.push(
    `  fan-out                  ${plural(target.direct.fanOut, "package")}`
  );
  lines.push(`  transitive dependents    ${target.transitive.dependents}`);
  lines.push(`  transitive dependencies  ${target.transitive.dependencies}`);
  lines.push(`  downstream depth         ${target.depth.downstream}`);
  lines.push(`  upstream depth           ${target.depth.upstream}`);
  lines.push(`  dependent reach          ${percent(target.reach.dependents)}`);
  lines.push(
    `  dependency reach         ${percent(target.reach.dependencies)}`
  );
  lines.push(
    `  cycle                    ${target.cycle.member ? `yes · ${plural(target.cycle.size, "package")}` : "no"}`
  );
  lines.push("");
  lines.push("POPULATION");
  lines.push(
    `  ${plural(population.packages, "internal package")} · ${plural(population.modules, "module")}`
  );

  const count = config.dependencyGravity.report.topModules;
  const sections: [
    string,
    (gravity: DependencyGravity) => number,
    (gravity: DependencyGravity) => string,
  ][] = [
    ["MOST DEPENDED-ON MODULES", (g) => g.direct.fanIn, gravityModuleLine],
    [
      "HIGHEST FAN-OUT MODULES",
      (g) => g.direct.fanOut,
      (g) => `fan-out ${g.direct.fanOut} · fan-in ${g.direct.fanIn}`,
    ],
    [
      "DEEPEST DEPENDENCY CHAINS",
      (g) => g.depth.upstream,
      (g) =>
        `upstream depth ${g.depth.upstream} · downstream depth ${g.depth.downstream}`,
    ],
    [
      "LARGEST TRANSITIVE REACH",
      (g) => g.transitive.dependents,
      (g) =>
        `${plural(g.transitive.dependents, "transitive dependent")} · reach ${percent(g.reach.dependents)}`,
    ],
  ];
  for (const [title, metric, line] of sections) {
    const top = topModulesBy(modules, metric, count);
    if (top.length === 0) {
      continue;
    }
    lines.push("");
    lines.push(title);
    for (const gravity of top) {
      lines.push("");
      lines.push(`  ${gravity.node.id}`);
      lines.push(`    ${line(gravity)}`);
    }
  }

  concentrationSection(
    "INCOMING EDGE CONCENTRATION",
    incomingConcentration,
    count,
    lines
  );
  concentrationSection(
    "OUTGOING EDGE CONCENTRATION",
    outgoingConcentration,
    count,
    lines
  );
  lines.push("");
  return lines.join("\n");
}

function distributionLine(label: string, aggregate: MetricAggregate): string {
  const { p50, p90, p95, max } = aggregate.distribution;
  return `  ${label.padEnd(12)}p50 ${p50} · p90 ${p90} · p95 ${p95} · max ${max}`;
}

function renderComplexitySummary(report: SurfaceReport, lines: string[]): void {
  const { summary } = report.localComplexity;
  if (summary.functionsAnalyzed === 0) {
    return;
  }
  lines.push("");
  lines.push("LOCAL COMPLEXITY");
  lines.push(`  ${plural(summary.functionsAnalyzed, "function")} analyzed`);
  lines.push("");
  lines.push(distributionLine("Decisions", summary.decisions));
  lines.push(distributionLine("Nesting", summary.nesting));
  lines.push(distributionLine("Parameters", summary.parameters));
  lines.push(distributionLine("Statements", summary.statements));
}

function complexityLine(fn: FunctionComplexity): string {
  const { metrics } = fn;
  return (
    `${metrics.decisions.total} decisions` +
    ` (${metrics.decisions.controlFlow} control flow · ${metrics.decisions.expression} expression)` +
    ` · nesting ${metrics.nesting.max}` +
    ` · ${plural(metrics.parameters.total, "parameter")}` +
    ` · ${plural(metrics.statements, "statement")}`
  );
}

function topBy(
  functions: FunctionComplexity[],
  metric: (fn: FunctionComplexity) => number,
  count: number
): FunctionComplexity[] {
  return functions
    .filter((fn) => metric(fn) > 0)
    .sort(
      (a, b) =>
        metric(b) - metric(a) || a.file.localeCompare(b.file) || a.line - b.line
    )
    .slice(0, count);
}

/**
 * Focused local-complexity view. "MOST" / "DEEPEST" / "LARGEST" mean highest
 * measured count — descriptions of shape, not judgments of quality.
 */
export function renderComplexity(
  report: SurfaceReport,
  config: AnalysisConfig = ANALYSIS_CONFIG
): string {
  const { summary, functions } = report.localComplexity;
  const lines: string[] = [];
  lines.push("LOCAL COMPLEXITY");
  lines.push("═".repeat(16));
  lines.push(`Target  ${report.target.name ?? report.target.path}`);
  lines.push("");
  lines.push("FUNCTIONS");
  lines.push(`  ${summary.functionsAnalyzed} analyzed`);
  lines.push("");
  lines.push("DISTRIBUTION");
  lines.push(distributionLine("Decisions", summary.decisions));
  lines.push(distributionLine("Nesting", summary.nesting));
  lines.push(distributionLine("Parameters", summary.parameters));
  lines.push(distributionLine("Statements", summary.statements));

  const sections: [string, (fn: FunctionComplexity) => number][] = [
    ["MOST DECISIONS", (fn) => fn.metrics.decisions.total],
    ["DEEPEST NESTING", (fn) => fn.metrics.nesting.max],
    ["MOST PARAMETERS", (fn) => fn.metrics.parameters.total],
    ["LARGEST FUNCTIONS", (fn) => fn.metrics.statements],
  ];
  for (const [title, metric] of sections) {
    const top = topBy(
      functions,
      metric,
      config.localComplexity.report.topFunctions
    );
    if (top.length === 0) {
      continue;
    }
    lines.push("");
    lines.push(title);
    for (const fn of top) {
      lines.push("");
      lines.push(`  ${fn.name}`);
      lines.push(`    ${complexityLine(fn)}`);
      lines.push(`    ${fn.file}:${fn.line}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** Full metric vector for one function. Facts only; no score. */
export function renderFunctionComplexity(fn: FunctionComplexity): string {
  const { metrics } = fn;
  const lines: string[] = [];
  lines.push(fn.name);
  lines.push("═".repeat(fn.name.length));
  lines.push("");
  lines.push(`kind      ${fn.kind}`);
  lines.push(`location  ${fn.file}:${fn.line}`);
  const surface = [
    ...(fn.exported ? ["module exported"] : []),
    ...(fn.packagePublic ? ["package public"] : []),
  ];
  lines.push(
    `surface   ${surface.length > 0 ? surface.join(" · ") : "internal"}`
  );
  lines.push("");
  lines.push("DECISIONS");
  lines.push(`  total         ${metrics.decisions.total}`);
  lines.push(`  control flow  ${metrics.decisions.controlFlow}`);
  lines.push(`  expression    ${metrics.decisions.expression}`);
  lines.push("");
  lines.push(`  if        ${metrics.decisions.ifs}`);
  lines.push(`  else if   ${metrics.decisions.elseIfs}`);
  lines.push(`  switch    ${metrics.decisions.switches}`);
  lines.push(`  cases     ${metrics.decisions.cases}`);
  lines.push(`  ternary   ${metrics.decisions.ternaries}`);
  lines.push(`  logical   ${metrics.decisions.logical}`);
  lines.push(`  loops     ${metrics.decisions.loops}`);
  lines.push(`  catches   ${metrics.decisions.catches}`);
  lines.push("");
  lines.push(`NESTING     max ${metrics.nesting.max}`);
  lines.push("");
  lines.push("PARAMETERS");
  lines.push(`  total     ${metrics.parameters.total}`);
  lines.push(`  boolean   ${metrics.parameters.boolean}`);
  lines.push(`  optional  ${metrics.parameters.optional}`);
  lines.push(`  defaulted ${metrics.parameters.defaulted}`);
  lines.push(`  rest      ${metrics.parameters.rest}`);
  lines.push("");
  lines.push("EXITS");
  lines.push(`  return    ${metrics.exits.returns}`);
  lines.push(`  throw     ${metrics.exits.throws}`);
  lines.push(`  break     ${metrics.exits.breaks}`);
  lines.push(`  continue  ${metrics.exits.continues}`);
  lines.push("");
  lines.push(`STATEMENTS  ${metrics.statements}`);
  lines.push("");
  lines.push("CALLBACKS");
  lines.push(`  nested    ${metrics.callbacks.nestedFunctions}`);
  lines.push(`  depth     ${metrics.callbacks.maxDepth}`);
  lines.push("");
  lines.push("ASYNC");
  lines.push(`  async     ${metrics.async.async ? "yes" : "no"}`);
  lines.push(`  awaits    ${metrics.async.awaits}`);
  lines.push(`  generator ${metrics.async.generator ? "yes" : "no"}`);
  lines.push(`  yields    ${metrics.async.yields}`);
  lines.push("");
  lines.push("EXCEPTIONS");
  lines.push(`  try       ${metrics.exceptions.tries}`);
  lines.push(`  catch     ${metrics.exceptions.catches}`);
  lines.push(`  finally   ${metrics.exceptions.finals}`);
  lines.push("");
  return lines.join("\n");
}

export function renderMutation(mutation: MutationResult): string {
  const lines: string[] = [];
  const subject =
    mutation.plan.operation === "internalize-symbol"
      ? `${mutation.plan.target.package} · ${mutation.plan.subject.name}`
      : `${mutation.plan.source.package} → ${mutation.plan.destination.package}`;
  lines.push(mutation.operator.replace(/-/g, " ").toUpperCase());
  lines.push("═".repeat(mutation.operator.length));
  lines.push(`Target  ${subject}`);
  lines.push("");
  lines.push(`Result  ${mutation.status.toUpperCase()}`);

  if (mutation.changedFiles.length > 0) {
    lines.push("");
    lines.push(
      mutation.status === "preview"
        ? `${plural(mutation.changedFiles.length, "file")} would change`
        : `${plural(mutation.changedFiles.length, "file")} changed`
    );
    for (const file of mutation.changedFiles) {
      lines.push(`  ${file}`);
    }
  }

  if (mutation.blockers !== undefined && mutation.blockers.length > 0) {
    lines.push("");
    lines.push("BLOCKERS");
    for (const blocker of mutation.blockers) {
      lines.push(`  ${blocker.reason}: ${blocker.detail}`);
    }
  }

  if (mutation.verification !== undefined) {
    lines.push("");
    lines.push("VERIFY");
    lines.push("══════");
    for (const check of mutation.verification.checks) {
      lines.push(`  ${check.check.padEnd(36)} ${check.status.toUpperCase()}`);
      if (check.status === "fail") {
        lines.push(`    ${check.detail}`);
      }
    }
    lines.push("");
    lines.push("  Expected");
    lines.push(deltaLines(mutation.verification.predictedDelta));
    lines.push("  Observed");
    lines.push(deltaLines(mutation.verification.observedDelta));
  }

  if (mutation.status === "preview") {
    lines.push("");
    lines.push("No files changed. Use --write to apply.");
  }
  if (mutation.status === "rolled-back") {
    lines.push("");
    lines.push("VERIFICATION FAILED");
    lines.push("ROLLBACK COMPLETE");
  }
  lines.push("");
  return lines.join("\n");
}

function deltaLines(delta: StructuralDelta): string {
  const labels: [keyof StructuralDelta, string][] = [
    ["exportedSymbols", "exported symbols"],
    ["unusedExternalExports", "unused external exports"],
    ["totalSymbols", "total symbols"],
    ["externallyUsedSymbols", "externally used symbols"],
  ];
  const lines = labels
    .filter(([key]) => delta[key] !== undefined && delta[key] !== 0)
    .map(
      ([key, label]) => `    ${label.padEnd(24)} ${signed(delta[key] ?? 0)}`
    );
  return lines.length > 0 ? lines.join("\n") : "    no change";
}
