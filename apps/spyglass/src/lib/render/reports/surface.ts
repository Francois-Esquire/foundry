import type { AnalysisConfig } from "../../config";
import type {
  BoundaryInteractionTotals,
  MetricAggregate,
  ReductionOpportunity,
  ReductionPlan,
  SurfaceReport,
  SurfaceSymbol,
} from "../../types";
import type { RenderDensity } from "../context";
import {
  ago,
  count,
  evidenceLine,
  percent,
  plural,
  windowLabel,
} from "../format";
import type {
  BlockView,
  LabelValueRow,
  ReportView,
  SectionView,
} from "../views";
import {
  ANCHOR,
  blockerDefinitions,
  OPPORTUNITIES,
  SURFACE_RATIOS,
  signalDefinitions,
} from "./explanations";
import { signalBlocks, signalNames } from "./signals";
import { verdict } from "./verdict";

const churnPattern = /-/g;

/**
 * Default report: what is this → what stands out → who consumes it → what
 * could change → supporting detail. Every line reads a report field; the
 * builder sorts and slices but decides nothing.
 */
export function buildSurfaceView(
  report: SurfaceReport,
  config: AnalysisConfig,
  density: RenderDensity = "normal"
): ReportView {
  const compact = density === "compact";
  const expanded = density === "expanded";
  return {
    sections: [
      header(report, density),
      summary(report, density),
      signals(report, density),
      ...(compact
        ? []
        : [consumers(report, config, density), dependsOn(report)]),
      opportunities(report, config, density),
      ...(compact ? [] : [mostDistributed(report)]),
      ...(expanded
        ? [
            gravity(report),
            boundaries(report),
            pressure(report),
            churn(report),
            hotspots(report),
            coupling(report),
            radius(report),
            evolution(report),
            concepts(report),
            moduleOnlyExports(report),
            complexity(report),
            operators(report),
          ]
        : []),
    ].filter((section) => section !== undefined),
    title: "SEMANTIC SURFACE",
  };
}

function text(...lines: string[]): BlockView {
  return { kind: "text", lines };
}

function header(report: SurfaceReport, density: RenderDensity): SectionView {
  const rows: LabelValueRow[] = [
    { label: "Target", value: report.target.name ?? report.target.path },
  ];
  if (report.target.name !== undefined) {
    rows.push({ label: "Path", value: report.target.path });
  }
  const blocks: BlockView[] = [
    { kind: "labelValue", rows },
    text(""),
    verdict(report),
  ];
  if (report.anchor !== undefined) {
    blocks.push(text(""), {
      kind: "signal",
      summary: report.anchor.reason ?? report.anchor.target,
      title: "ANCHORED",
      tone: "anchored",
    });
    if (density !== "compact") {
      blocks.push({ kind: "note", lines: [ANCHOR], title: "Anchor" });
    }
  }
  return { blocks };
}

function summary(report: SurfaceReport, density: RenderDensity): SectionView {
  const { summary: reportSummary2 } = report;
  return {
    blocks: [
      {
        kind: "funnel",
        stages: [
          { label: "total symbols", value: reportSummary2.totalSymbols },
          {
            label: "module exports",
            value: reportSummary2.moduleExportedSymbols,
          },
          {
            label: "package-public",
            value: reportSummary2.packagePublicSymbols,
          },
          {
            label: "externally used",
            value: reportSummary2.externallyUsedSymbols,
          },
        ],
      },
      text(""),
      {
        items: [
          {
            denominator: reportSummary2.totalSymbols,
            label: "Declared package surface",
            numerator: reportSummary2.packagePublicSymbols,
            value: reportSummary2.declaredSurfaceRatio,
          },
          {
            denominator: reportSummary2.totalSymbols,
            label: "External surface",
            numerator: reportSummary2.externallyUsedSymbols,
            value: reportSummary2.externalSurfaceRatio,
          },
          {
            denominator: reportSummary2.packagePublicSymbols,
            label: "Export utilization",
            numerator: reportSummary2.externallyUsedSymbols,
            value: reportSummary2.exportUtilization,
          },
        ],
        kind: "ratio",
      },
      ...(density === "compact"
        ? []
        : [
            text(""),
            {
              kind: "note",
              lines: paragraphs(SURFACE_RATIOS),
              title: "Reading the surface ratios",
            } satisfies BlockView,
          ]),
    ],
    title: "SUMMARY",
  };
}

/** Blank line between definitions inside one note. */
function paragraphs(lines: readonly string[]): string[] {
  return lines.flatMap((line, index) => (index === 0 ? [line] : ["", line]));
}

function signals(
  report: SurfaceReport,
  density: RenderDensity
): SectionView | undefined {
  const blocks = signalBlocks(report, density);
  if (blocks.length === 0) {
    return undefined;
  }
  if (density !== "compact") {
    const definitions = signalDefinitions(signalNames(report));
    if (definitions.length > 0) {
      blocks.push(text(""), {
        kind: "note",
        lines: definitions,
        title: "What these signals mean",
      });
    }
  }
  return { blocks, title: "SIGNALS" };
}

function consumers(
  report: SurfaceReport,
  config: AnalysisConfig,
  density: RenderDensity
): SectionView | undefined {
  const { dependencies } = report;
  if (dependencies.incoming.length === 0) {
    return undefined;
  }
  const blocks: BlockView[] = [
    {
      items: dependencies.incoming.map((consumer) => ({
        detail: `${plural(consumer.symbolsUsed, "symbol")} · ${plural(consumer.references, "reference")}`,
        label: consumer.package,
        share: consumer.referenceShare,
      })),
      kind: "distribution",
    },
    text(
      "",
      `${dependencies.averageSymbolDistribution.toFixed(2)} consumer packages per symbol`
    ),
  ];
  if (density === "expanded") {
    const target = report.target.name ?? report.target.path;
    const shown = config.report.symbolsPerConsumer;
    for (const consumer of dependencies.incoming) {
      blocks.push(
        text(""),
        {
          from: consumer.package,
          kind: "edge",
          label: `${plural(consumer.symbolsUsed, "symbol")} · ${plural(consumer.references, "reference")} · ${consumer.usageNamespace} usage`,
          to: target,
        },
        {
          items: consumer.symbols.slice(0, shown).map((symbol) => ({
            label: symbol.symbolName,
            value: symbol.references,
          })),
          kind: "rankedList",
          overflow: Math.max(0, consumer.symbols.length - shown),
        }
      );
    }
  }
  return { blocks, title: "CONSUMERS" };
}

function dependsOn(report: SurfaceReport): SectionView | undefined {
  const { outgoing } = report.dependencies;
  if (outgoing.length === 0) {
    return undefined;
  }
  return {
    blocks: [
      {
        kind: "labelValue",
        rows: outgoing.map((dependency) => ({
          label: dependency.package,
          value: plural(dependency.moduleEdges, "module edge"),
        })),
      },
    ],
    title: "DEPENDS ON",
  };
}

function evidenceLines(opportunity: ReductionOpportunity): string[] {
  return opportunity.evidence.map((entry) =>
    evidenceLine(entry.metric, entry.value)
  );
}

function planStatusCount(
  report: SurfaceReport,
  status: ReductionPlan["status"]
): number {
  return report.plans.filter(
    (plan) => plan.operation === "internalize-symbol" && plan.status === status
  ).length;
}

function opportunities(
  report: SurfaceReport,
  config: AnalysisConfig,
  density: RenderDensity
): SectionView | undefined {
  const compact = density === "compact";
  const blocks: BlockView[] = [];
  const byOperation = (operation: ReductionOpportunity["operation"]) =>
    report.opportunities.filter((item) => item.operation === operation);

  const internalize = byOperation("internalize-symbol");
  const [first] = internalize;
  opportunitiesEntries(
    first,
    report,
    blocks,
    internalize,
    compact,
    density,
    config
  );
  const visitFold = () => {
    for (const fold of byOperation("fold-package")) {
      if (blocks.length > 0) {
        blocks.push(text(""));
      }
      blocks.push(
        {
          kind: "signal",
          summary: fold.summary,
          title: "FOLD CANDIDATE",
          tone: "emphasis",
          ...(!compact && { evidence: evidenceLines(fold) }),
        },
        {
          from: fold.subject.name,
          kind: "edge",
          label: `evidence confidence ${percent(fold.evidenceConfidence)}`,
          to: fold.target?.name ?? "?",
        }
      );
      for (const caution of fold.cautions) {
        blocks.push({
          kind: "signal",
          summary: caution.detail,
          title: "CAUTION",
          tone: "caution",
        });
      }
      const plan = report.plans.find(
        (candidate) =>
          candidate.operation === "fold-package" &&
          candidate.source.package === fold.subject.id
      );
      if (plan?.status === "blocked") {
        blocks.push({
          evidence: plan.blockers.map((blocker) => blocker.detail),
          kind: "signal",
          title: "BLOCKED",
          tone: "blocked",
        });
      } else if (plan !== undefined) {
        const scale = plan.intelligence?.scale;
        blocks.push(
          text(
            `Plan ${plan.status}` +
              (scale === undefined
                ? ""
                : ` · ${plural(scale.files.total, "file")} · ${scale.symbols.externallyUsed} consumed / ${scale.symbols.packagePublic} public`)
          )
        );
      }
    }
  };

  visitFold();

  for (const preserve of byOperation("preserve-shared-boundary")) {
    if (blocks.length > 0) {
      blocks.push(text(""));
    }
    blocks.push({
      kind: "signal",
      summary: preserve.summary,
      title: "PRESERVE SHARED BOUNDARY",
      tone: "neutral",
      ...(!compact && { evidence: evidenceLines(preserve) }),
    });
  }

  if (!compact) {
    for (const ineligible of report.ineligibleOperations) {
      if (blocks.length > 0) {
        blocks.push(text(""));
      }
      blocks.push({
        checks: ineligible.failedGates.map((gate) => ({
          label: `${gate.gate}  expected ${String(gate.expected)} · actual ${String(gate.actual)}`,
          passed: false,
        })),
        kind: "gate",
        result: "NOT ELIGIBLE",
        title: `${ineligible.operation.replace(churnPattern, " ").toUpperCase()} ELIGIBILITY`,
      });
    }
  }

  if (blocks.length === 0) {
    return undefined;
  }
  if (!compact) {
    const blockers = blockerDefinitions(
      report.plans.flatMap((plan) =>
        plan.blockers.map((blocker) => blocker.reason)
      )
    );
    blocks.push(text(""), {
      kind: "note",
      lines: paragraphs([...OPPORTUNITIES, ...blockers]),
      title: "Reading opportunities",
    });
  }
  return { blocks, title: "OPPORTUNITIES" };
}

function opportunitiesEntries(
  first: ReductionOpportunity | undefined,
  report: SurfaceReport,
  blocks: BlockView[],
  internalize: ReductionOpportunity[],
  compact: boolean,
  density: RenderDensity,
  config: AnalysisConfig
) {
  if (first !== undefined) {
    const ready = planStatusCount(report, "ready");
    const blocked = planStatusCount(report, "blocked");
    const unsupported = planStatusCount(report, "unsupported");
    const reasons = Object.entries(
      report.operators.find((operator) => operator.id === "internalize-export")
        ?.unsupportedReasons ?? {}
    );
    const evidence = [
      `${ready} plan-ready` +
        (blocked > 0 ? ` · ${blocked} blocked` : "") +
        (unsupported > 0 ? ` · ${unsupported} unsupported` : ""),
    ];
    if (reasons.length > 0) {
      evidence.push(
        `unsupported: ${reasons.map(([reason, total]) => `${reason} ${total}`).join(" · ")}`
      );
    }
    blocks.push({
      kind: "signal",
      summary: `${plural(internalize.length, "unused external export")} · evidence confidence ${percent(first.evidenceConfidence)}`,
      title: "INTERNALIZE SYMBOLS",
      tone: "emphasis",
      ...(!compact && { evidence }),
    });
    if (!compact) {
      const names = internalize
        .map((item) => item.subject.name)
        .sort((a, b) => a.localeCompare(b));
      const shown =
        density === "expanded"
          ? names.length
          : config.report.unusedExportsShown;
      blocks.push({
        items: names.slice(0, shown),
        kind: "list",
        overflow: Math.max(0, names.length - shown),
      });
    }
  }
}

function usedSymbols(report: SurfaceReport): SurfaceSymbol[] {
  return report.symbols.filter(
    (symbol) =>
      symbol.exported &&
      symbol.externalReferences + symbol.externalImportSites > 0
  );
}

function mostDistributed(report: SurfaceReport): SectionView | undefined {
  const distributed = usedSymbols(report)
    .sort(
      (a, b) =>
        b.consumerPackages.length - a.consumerPackages.length ||
        b.externalReferences - a.externalReferences ||
        a.name.localeCompare(b.name)
    )
    .slice(0, 5);
  if (distributed.length === 0) {
    return undefined;
  }
  return {
    blocks: [
      {
        items: distributed.map((symbol) => ({
          detail: [
            `${symbol.kind} · ${plural(symbol.externalReferences, "reference")} · ${symbol.usageNamespace} usage · ${symbol.access} access`,
          ],
          label: symbol.name,
          value: symbol.consumerPackages.length,
        })),
        kind: "rankedList",
      },
    ],
    title: "MOST DISTRIBUTED",
  };
}

function gravity(report: SurfaceReport): SectionView {
  const { target } = report.dependencyGravity;
  const lines = [
    `fan-in ${target.direct.fanIn} · fan-out ${target.direct.fanOut} packages`,
    `transitive ${target.transitive.dependents} dependents · ${target.transitive.dependencies} dependencies`,
    `reach ${percent(target.reach.dependents)} dependents · ${percent(target.reach.dependencies)} dependencies`,
  ];
  if (target.cycle.member) {
    lines.push(`cycle member · ${plural(target.cycle.size, "package")}`);
  }
  return { blocks: [text(...lines)], title: "DEPENDENCY GRAVITY" };
}

function totalsLine(label: string, totals: BoundaryInteractionTotals): string {
  if (totals.packages === 0) {
    return `${label}  0 packages`;
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
  return `${label}  ${parts.join(" · ")}`;
}

function boundaries(report: SurfaceReport): SectionView {
  const { summary: reportSummary } = report.boundaryInteractions;
  return {
    blocks: [
      text(
        totalsLine("incoming", reportSummary.incoming),
        totalsLine("outgoing", reportSummary.outgoing)
      ),
    ],
    title: "BOUNDARY INTERACTIONS",
  };
}

function pressure(report: SurfaceReport): SectionView | undefined {
  const { signals: pressureSignals, boundaries: pressureBoundaries } =
    report.structuralPressure;
  if (pressureSignals.length === 0 && pressureBoundaries.length === 0) {
    return undefined;
  }
  const lines: string[] = pressureSignals.map((signal) => signal.kind);
  if (pressureBoundaries.length > 0) {
    if (pressureSignals.length > 0) {
      lines.push("");
    }
    lines.push(plural(pressureBoundaries.length, "boundary-pressure signal"));
  }
  return { blocks: [text(...lines)], title: "STRUCTURAL PRESSURE" };
}

function churn(report: SurfaceReport): SectionView {
  const { churn: currentChurn } = report;
  if (!currentChurn.available) {
    return {
      blocks: [
        text(`unavailable (${currentChurn.reason.replace(churnPattern, " ")})`),
      ],
      title: "CHURN",
    };
  }
  const { summary: currentSummary5, history, target } = currentChurn;
  return {
    blocks: [
      text(
        `${plural(currentSummary5.filesAnalyzed, "file")} · ${plural(currentSummary5.commits, "commit")} in ${windowLabel(history.windowDays)}${history.historyComplete ? "" : " (shallow clone)"}`,
        `${count(currentSummary5.linesChanged)} lines changed · ${plural(currentSummary5.authors, "author")}`,
        `last changed ${ago(target.daysSinceLastChange)}`
      ),
    ],
    title: "CHURN",
  };
}

function hotspots(report: SurfaceReport): SectionView | undefined {
  const { hotspots: currentHotspots } = report;
  if (!currentHotspots.available) {
    return undefined;
  }
  const [top] = currentHotspots.files;
  if (top === undefined) {
    return { blocks: [text("none under current policy")], title: "HOTSPOTS" };
  }
  return {
    blocks: [
      text(
        `${plural(currentHotspots.summary.hotspots, "source file")} of ${currentHotspots.summary.eligibleSourceFiles}`,
        `highest: ${top.file} · ${plural(top.evolution.commits, "commit")} · ${percent(top.evolution.commitPercentile)} commit percentile`
      ),
    ],
    title: "HOTSPOTS",
  };
}

function coupling(report: SurfaceReport): SectionView | undefined {
  const currentCoupling = report.changeCoupling;
  if (!currentCoupling.available) {
    return undefined;
  }
  const { summary: currentSummary4 } = currentCoupling;
  if (currentSummary4.filePairs === 0 && currentSummary4.packagePairs === 0) {
    return {
      blocks: [text("no strong pairs under current policy")],
      title: "CHANGE COUPLING",
    };
  }
  return {
    blocks: [
      text(
        `${plural(currentSummary4.filePairs, "strong file pair")} · ${currentSummary4.crossPackagePairs} cross-package · ${plural(currentSummary4.packagePairs, "package pair")}`,
        `${currentSummary4.filePairsWithoutStaticEdge} strong file ${currentSummary4.filePairsWithoutStaticEdge === 1 ? "pair has" : "pairs have"} no static dependency`
      ),
    ],
    title: "CHANGE COUPLING",
  };
}

function radius(report: SurfaceReport): SectionView | undefined {
  const currentRadius = report.changeRadius;
  if (!currentRadius.available || currentRadius.summary.commits === 0) {
    return undefined;
  }
  const { summary: currentSummary3 } = currentRadius;
  return {
    blocks: [
      text(
        `packages/commit p50 ${currentSummary3.packages.p50} · p90 ${currentSummary3.packages.p90} · max ${currentSummary3.packages.max}`,
        `cross-package commits ${percent(currentSummary3.crossPackageRate)} · boundary-crossing ${percent(currentSummary3.boundaryCrossingRate)}`
      ),
    ],
    title: "CHANGE RADIUS",
  };
}

function evolution(report: SurfaceReport): SectionView | undefined {
  const currentEvolution = report.evolutionaryPressure;
  if (!currentEvolution.available) {
    return undefined;
  }
  const lines: string[] = [];
  if (currentEvolution.historicalSupport === "insufficient") {
    lines.push(
      `insufficient history (${plural(currentEvolution.support.eligibleRadiusCommits, "eligible commit")})`
    );
    return { blocks: [text(...lines)], title: "EVOLUTIONARY PRESSURE" };
  }
  if (
    currentEvolution.reinforced.length === 0 &&
    currentEvolution.tensions.length === 0
  ) {
    lines.push("no reinforced static pressure under current policy");
  }
  if (currentEvolution.reinforced.length > 0) {
    lines.push("reinforced");
    for (const signal of currentEvolution.reinforced) {
      lines.push(`  ${signal.staticSignal}`);
    }
  }
  if (currentEvolution.tensions.length > 0) {
    lines.push("tensions");
    for (const kind of new Set(currentEvolution.tensions.map((t) => t.kind))) {
      lines.push(`  ${kind}`);
    }
  }
  lines.push("history");
  lines.push(
    `  ${plural(currentEvolution.support.eligibleRadiusCommits, "eligible commit")}`
  );
  return { blocks: [text(...lines)], title: "EVOLUTIONARY PRESSURE" };
}

function concepts(report: SurfaceReport): SectionView | undefined {
  const { summary: currentSummary2, families } = report.conceptInventory;
  if (currentSummary2.seeds === 0) {
    return undefined;
  }
  const lines: string[] = [];
  lines.push(
    `${plural(currentSummary2.seeds, "seed")} · ${currentSummary2.crossPackageFamilies} cross-package ${currentSummary2.crossPackageFamilies === 1 ? "family" : "families"} · ${plural(currentSummary2.implementations, "implementation")}`
  );
  const { distribution } = report.conceptInventory;
  if (distribution !== undefined) {
    lines.push(
      `${distribution.implementationSplit} implementation-split · ${distribution.referenceDistributed} reference-distributed · ${distribution.representationConcentrated} representation-concentrated${distribution.temporallyCoupled > 0 ? ` · ${distribution.temporallyCoupled} with co-changing members` : ""}`
    );
  }
  const [top] = families;
  if (top !== undefined && top.distribution.moduleCount > 1) {
    lines.push(
      `most distributed: ${top.seed.name} · ${plural(top.distribution.packageCount, "package")} · ${plural(top.distribution.moduleCount, "module")}`
    );
  }
  const overlap = report.conceptOverlap.summary;
  if (overlap.candidates > 0) {
    lines.push(
      `${plural(overlap.candidates, "overlap candidate")} · ${overlap.crossPackageCandidates} cross-package · ${overlap.nearEquivalent} near-equivalent · ${overlap.conversionPairs} conversion pairs`
    );
  }
  const ownership = report.conceptOwnership.summary;
  lines.push(
    `centers: ${ownership.aligned} aligned · ${ownership.distributed} distributed · ${ownership.divergent} divergent · ${ownership.insufficientEvidence} insufficient evidence`
  );
  const locality = report.conceptBehavioralLocality.summary;
  lines.push(
    `locality: ${locality.local} local · ${locality.singlePackageDistributed} single-package · ${locality.crossPackageLocalized + locality.crossPackageDistributed} cross-package · ${locality.behaviorLight} behavior-light · ${locality.parallelImplementations} parallel implementations`
  );
  return { blocks: [text(...lines)], title: "CONCEPTS" };
}

function moduleOnlyExports(report: SurfaceReport): SectionView | undefined {
  const names = report.symbols
    .filter((symbol) => symbol.exported && !symbol.packagePublic)
    .map((symbol) => symbol.name)
    .sort((a, b) => a.localeCompare(b));
  if (names.length === 0) {
    return undefined;
  }
  return { blocks: [text(...names)], title: "MODULE-ONLY EXPORTS" };
}

function distributionLine(label: string, aggregate: MetricAggregate): string {
  const { p50, p90, p95, max } = aggregate.distribution;
  return `${label.padEnd(12)}p50 ${p50} · p90 ${p90} · p95 ${p95} · max ${max}`;
}

function complexity(report: SurfaceReport): SectionView | undefined {
  const { summary: currentSummary } = report.localComplexity;
  if (currentSummary.functionsAnalyzed === 0) {
    return undefined;
  }
  return {
    blocks: [
      text(
        `${plural(currentSummary.functionsAnalyzed, "function")} analyzed`,
        "",
        distributionLine("Decisions", currentSummary.decisions),
        distributionLine("Nesting", currentSummary.nesting),
        distributionLine("Parameters", currentSummary.parameters),
        distributionLine("Statements", currentSummary.statements)
      ),
    ],
    title: "LOCAL COMPLEXITY",
  };
}

function operators(report: SurfaceReport): SectionView {
  const lines = report.operators.map((operator) => {
    let counts: string;
    if (operator.opportunities === 0) {
      counts = "no opportunity";
    } else {
      counts =
        `${plural(operator.opportunities, "candidate")} · ${operator.plans.ready} plan-ready` +
        (operator.plans.blocked > 0
          ? ` · ${operator.plans.blocked} blocked`
          : "") +
        (operator.plans.unsupported > 0
          ? ` · ${operator.plans.unsupported} unsupported`
          : "");
    }
    return `${operator.id.padEnd(20)} ${counts} · mutation ${operator.capabilities.apply ? "supported" : "unsupported"}`;
  });
  return { blocks: [text(...lines)], title: "OPERATORS" };
}
