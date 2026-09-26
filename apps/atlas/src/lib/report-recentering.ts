import type { AnalysisConfig } from "./config";
import type {
  ArchitecturalReviewEvidence,
  ArchitecturalReviewReport,
  ArchitecturalScenarioReview,
  MiscenteredConceptFinding,
  MiscenteredConceptReport,
  MiscenteringOutcome,
  RecenteringCandidate,
  RecenteringCandidateReport,
  RecenteringScenario,
  RecenteringScenarioFinding,
  RecenteringScenarioReport,
  ScenarioImpactAnalysis,
  ScenarioImpactFinding,
  ScenarioImpactReport,
  ScenarioMetricDelta,
  ScenarioPlacement,
} from "./types";

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Evidence kinds whose numeric value is a share, so `1` renders as 100%. */
const SHARE_KINDS = new Set([
  "semantic-vs-behavior",
  "semantic-vs-representation",
  "dependency-misalignment",
  "primary-strong-package-share",
  "top-two-module-share",
  "primary-representation-share",
  "seed-module-incoming-edge-share",
]);

function candidateLine(item: RecenteringCandidate): string {
  const parts = [
    item.status,
    item.shapes.length > 0 ? item.shapes.join(", ") : "—",
    `tensions ${item.tensions.join(", ")}`,
    plural(item.dimensions.length, "dimension"),
    `${item.behavior.strong} strong / ${item.behavior.weak} weak behaviors`,
  ];
  return parts.join(" · ");
}

/** Summary section for `--concepts`; candidates and protected entries only. */
export function renderRecenteringSection(
  report: RecenteringCandidateReport,
  config: AnalysisConfig,
  lines: string[]
): void {
  const { summary, candidates } = report;
  if (summary.evaluated === 0) {
    return;
  }
  const shown = config.recentering.report.topCandidates;
  lines.push("");
  lines.push("RE-CENTERING CANDIDATES");
  lines.push(
    `  ${summary.evaluated} evaluated · ${summary.candidates} candidates · ${summary.protected} protected · ${summary.insufficientEvidence} insufficient evidence`
  );
  const shapes = Object.entries(summary.byShape).filter(
    ([, count]) => count > 0
  );
  if (shapes.length > 0) {
    lines.push(
      `  shapes: ${shapes.map(([shape, count]) => `${count} ${shape}`).join(" · ")}`
    );
  }
  const eligible = candidates.filter(
    (item) => item.status !== "insufficient-evidence"
  );
  for (const item of eligible.slice(0, shown)) {
    lines.push(
      `    ${item.subject.concept.name.padEnd(32)} ${candidateLine(item)}`
    );
  }
  if (eligible.length > shown) {
    lines.push(`    … ${eligible.length - shown} more (see --json)`);
  }
  renderMiscenteredSection(report.miscentered, config, lines);
  renderScenarioSection(report.scenarios, config, lines);
  renderImpactSection(report.impacts, report.scenarios, config, lines);
  renderReviewSection(report.reviews, report.scenarios, config, lines);
}

function reviewEvidence(
  rows: ArchitecturalReviewEvidence[],
  label: "dimension" | "kind"
): string {
  return rows
    .map((row) => `${row[label]}: ${row.detail} (${row.certainty})`)
    .join(" · ");
}

/** Top findings with disposition and one status line per scenario; the focused view has the evidence. */
function renderReviewSection(
  report: ArchitecturalReviewReport,
  scenarios: RecenteringScenarioReport,
  config: AnalysisConfig,
  lines: string[]
): void {
  if (report.reviews.length === 0) {
    return;
  }
  const { summary } = report;
  const policy = config.recentering.review.report;
  lines.push("");
  lines.push("ARCHITECTURE REVIEW");
  lines.push(
    `  ${plural(summary.findingsReviewed, "finding")} reviewed · ${summary.preserveCurrent} preserve current · ${summary.credibleAlternative} credible alternative · ${summary.multipleTradeoffs} multiple tradeoffs · ${summary.intentBlocked} intent blocked · ${summary.insufficientEvidence} insufficient evidence · ${summary.runtimeMs} ms`
  );
  lines.push(
    `  scenarios: ${summary.scenariosReviewed} reviewed · ${summary.viable} viable · ${summary.dominated} dominated (${summary.dominatedBaselines} baselines) · ${summary.invalid} invalid · ${summary.indistinguishable} indistinguishable · ${summary.insufficientEvidenceScenarios} insufficient`
  );
  const scenarioById = new Map(
    scenarios.findings
      .flatMap((finding) => finding.scenarios)
      .map((scenario) => [scenario.id, scenario])
  );
  report.reviews.slice(0, policy.topFindings).forEach((review, index) => {
    lines.push(
      `    ${index + 1}. ${review.concept.name} — ${review.disposition}`
    );
    for (const reason of review.rationale) {
      lines.push(`       ${reason}`);
    }
    review.scenarios
      .slice(0, policy.topScenariosPerFinding)
      .forEach((item, letter) => {
        const scenario = scenarioById.get(item.scenarioId);
        lines.push(
          `       ${String.fromCharCode(65 + letter)}. ${scenario === undefined ? item.kind : scenarioLine(scenario)} · ${item.status} · ${item.character} · intent ${item.intentCompatibility} · evidence ${item.evidenceCompleteness}`
        );
      });
    if (review.scenarios.length > policy.topScenariosPerFinding) {
      lines.push(
        `       … ${review.scenarios.length - policy.topScenariosPerFinding} more (see --json)`
      );
    }
  });
  if (report.reviews.length > policy.topFindings) {
    lines.push(
      `    … ${report.reviews.length - policy.topFindings} more (see --json)`
    );
  }
}

/** Focused view: every scenario's status, effects, gains, costs, preservations, unresolved points, then the disposition. */
export function renderArchitecturalReview(
  review: ArchitecturalScenarioReview | undefined,
  scenarios?: RecenteringScenarioFinding
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("ARCHITECTURE REVIEW");
  if (review === undefined) {
    lines.push("  no review (no scenarios)");
    return lines.join("\n");
  }
  const scenarioById = new Map(
    (scenarios?.scenarios ?? []).map((scenario) => [scenario.id, scenario])
  );
  lines.push(`  ${review.concept.name} · ${review.signal.replace("-", " ")}`);
  review.scenarios.forEach((item, index) => {
    const scenario = scenarioById.get(item.scenarioId);
    lines.push("");
    lines.push(
      `  ${String.fromCharCode(65 + index)}. ${scenario === undefined ? item.kind : scenarioLine(scenario)} — ${item.status}`
    );
    lines.push(
      `     ${item.character}${item.effects.length > 0 ? ` · ${item.effects.join(", ")}` : ""} · intent ${item.intentCompatibility} · evidence ${item.evidenceCompleteness}`
    );
    if (item.strengths.length > 0) {
      lines.push(
        `     gains      ${reviewEvidence(item.strengths, "dimension")}`
      );
    }
    if (item.costs.length > 0) {
      lines.push(`     costs      ${reviewEvidence(item.costs, "dimension")}`);
    }
    if (item.preservations.length > 0) {
      lines.push(
        `     preserves  ${reviewEvidence(item.preservations, "kind")}`
      );
    }
    if (item.uncertainties.length > 0) {
      lines.push(
        `     unresolved ${item.uncertainties.map((row) => `${row.kind}: ${row.detail}`).join(" · ")}`
      );
    }
    for (const row of item.constraints) {
      lines.push(`     ! ${row.constraint.kind.padEnd(34)} ${row.consequence}`);
    }
  });
  for (const row of review.dominated) {
    const kindOf = (id: string) =>
      review.scenarios.find((item) => item.scenarioId === id)?.kind ?? id;
    lines.push("");
    lines.push(
      `  ${kindOf(row.scenarioId)} is dominated by ${kindOf(row.dominatedBy)}: ${row.evidence.join(" · ")}`
    );
  }
  lines.push("");
  lines.push(`  Review  ${review.disposition}`);
  for (const reason of review.rationale) {
    lines.push(`    ${reason}`);
  }
  for (const row of review.unresolved) {
    lines.push(`    ? ${row.kind}: ${row.detail}`);
  }
  return lines.join("\n");
}

function deltaText(delta: ScenarioMetricDelta): string {
  const value = (count: number | null) =>
    count === null ? "unknown" : String(count);
  return delta.delta === 0 && delta.certainty === "certain"
    ? `${value(delta.current)} unchanged`
    : `${value(delta.current)} → ${value(delta.predicted)} (${delta.certainty})`;
}

/** One line per scenario: the span, boundary, surface, and intent facts, no reading of them. */
function impactLine(item: ScenarioImpactAnalysis): string {
  const { locality, boundaries, surface, intent } = item.impact;
  const parts = [
    `packages ${deltaText(locality.sourcePackageCount)}`,
    `boundaries ${boundaries.eliminated.length} eliminated · ${boundaries.reduced.length} reduced · ${boundaries.added.length} added`,
    surface.packagePublicContractRelocated
      ? "surface relocates"
      : "surface stays",
    `intent ${intent.compatibility}`,
    `${item.certainty.certain}c/${item.certainty.conditional}k/${item.certainty.unknown}u`,
  ];
  return parts.join(" · ");
}

/** Top findings with a one-line vector per scenario, in scenario order; the focused view has the full vector. */
function renderImpactSection(
  report: ScenarioImpactReport,
  scenarios: RecenteringScenarioReport,
  config: AnalysisConfig,
  lines: string[]
): void {
  if (report.findings.length === 0) {
    return;
  }
  const { summary } = report;
  const policy = config.recentering.impact.report;
  lines.push("");
  lines.push("SCENARIO IMPACT");
  lines.push(
    `  ${plural(summary.scenarios, "scenario")} simulated (${summary.simulated} simulated · ${summary.partiallySimulated} partial · ${summary.blocked} blocked) · ${summary.certainChanges} certain · ${summary.conditionalChanges} conditional · ${summary.unknownConsequences} unknown · ${summary.runtimeMs} ms`
  );
  lines.push(
    `  boundaries: ${summary.boundaryEliminations} eliminated · ${summary.boundaryReductions} reduced · ${summary.boundaryAdditions} added · ${summary.dependencyEliminations} package edges removable · spans: ${summary.localityDecreases} contract · ${summary.localityIncreases} expand · ${summary.surfaceRelocations} surface relocations · ${summary.representationBoundariesPreserved} persistence boundaries preserved · ${summary.anchorConflicts} anchor conflicts`
  );
  const scenarioById = new Map(
    scenarios.findings
      .flatMap((finding) => finding.scenarios)
      .map((scenario) => [scenario.id, scenario])
  );
  report.findings.slice(0, policy.topFindings).forEach((finding, index) => {
    lines.push(`    ${index + 1}. ${finding.subject.name}`);
    finding.scenarios
      .slice(0, policy.topScenariosPerFinding)
      .forEach((item, letter) => {
        const scenario = scenarioById.get(item.scenarioId);
        lines.push(
          `       ${String.fromCharCode(65 + letter)}. ${scenario === undefined ? item.kind : scenarioLine(scenario)}`
        );
        lines.push(`          ${impactLine(item)}`);
      });
    if (finding.scenarios.length > policy.topScenariosPerFinding) {
      lines.push(
        `       … ${finding.scenarios.length - policy.topScenariosPerFinding} more (see --json)`
      );
    }
  });
  if (report.findings.length > policy.topFindings) {
    lines.push(
      `    … ${report.findings.length - policy.topFindings} more (see --json)`
    );
  }
}

/** Focused view: every scenario's full vector, changes, preservations, uncertainties, constraints. */
export function renderScenarioImpacts(
  item: ScenarioImpactFinding | undefined,
  scenarios?: RecenteringScenarioFinding
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("SCENARIO IMPACT");
  if (item === undefined) {
    lines.push("  no impact (no scenarios)");
    return lines.join("\n");
  }
  const scenarioById = new Map(
    (scenarios?.scenarios ?? []).map((scenario) => [scenario.id, scenario])
  );
  item.scenarios.forEach((analysis, index) => {
    const scenario = scenarioById.get(analysis.scenarioId);
    const { dependency, boundaries, locality, surface, representation } =
      analysis.impact;
    const { behavior, implementation, evolution, intent } = analysis.impact;
    lines.push("");
    lines.push(
      `  ${String.fromCharCode(65 + index)}. ${scenario === undefined ? analysis.kind : scenarioLine(scenario)}`
    );
    lines.push(
      `     status ${analysis.status} · certainty ${analysis.certainty.certain} certain · ${analysis.certainty.conditional} conditional · ${analysis.certainty.unknown} unknown`
    );
    lines.push("     behavior");
    lines.push(
      `       packages ${deltaText(locality.sourcePackageCount)} · source modules ${deltaText(locality.sourceModuleCount)} · behavior edges ${deltaText(locality.behavioralBoundaryEdges)} · disconnected pairs ${deltaText(locality.disconnectedBehaviorPairs)}`
    );
    lines.push(
      `       governing ${behavior.governingBehaviorRelocated} relocate · ${behavior.governingBehaviorPreserved} stay · ${behavior.governingBehaviorUnplaced} unplaced · ${behavior.consumerBehaviorUnaffected} consumer behaviors unaffected · shape ${locality.shapeTransition.from} → ${locality.shapeTransition.to ?? "unknown"} (${locality.shapeTransition.certainty})`
    );
    lines.push("     boundaries");
    for (const state of boundaries.current) {
      const detail =
        state.outcome === "reduced" || state.outcome === "eliminated"
          ? ` · ${state.vacatedModules.length} module(s) leave, ${state.remainingModules.length} remain · ${state.conceptImportSitesRemoved ?? 0}/${state.importSites ?? "?"} import sites${state.exclusive ? " · exclusive" : ""}`
          : state.importSites === null
            ? " · unmeasured"
            : ` · ${state.conceptImportSites ?? 0}/${state.importSites} concept import sites`;
      lines.push(
        `       ${state.edge.padEnd(40)} ${state.outcome} (${state.certainty})${detail}`
      );
    }
    for (const edge of boundaries.added) {
      lines.push(`       ${edge.padEnd(40)} added (conditional)`);
    }
    lines.push(
      `       package edges: ${dependency.removed.length} removable · ${dependency.added.length} added · ${dependency.preserved.length} preserved · ${dependency.uncertain.length} uncertain`
    );
    lines.push("     surface");
    lines.push(
      `       ${surface.packagePublicContractRelocated ? `package-public contract ${surface.publicExposureRemoved.join(", ")} → ${surface.publicExposureAdded.join(", ")} · transition unresolved` : `semantic contract stays ${analysis.baseline.semanticCenter}`} · consumers ${surface.consumers.packages.length > 0 ? `${surface.consumers.packages.join(", ")} ${surface.consumers.impact}` : "none"}`
    );
    lines.push("     representation");
    lines.push(
      `       representations ${representation.semanticRepresentationsCurrent.join(", ") || "—"} → ${representation.semanticRepresentationsPredicted.join(", ") || "—"} (${representation.certainty}) · persistence preserved ${representation.persistenceRepresentationsPreserved.join(", ") || "—"} · converters preserved ${representation.convertersPreserved.join(", ") || "—"}${representation.representationBoundariesAdded.length > 0 ? ` · boundary made explicit: ${representation.representationBoundariesAdded.join(", ")}` : ""}`
    );
    lines.push(
      `     implementation ${implementation.currentCenters.join(", ") || "—"} → ${implementation.predictedCenters.join(", ") || "—"}${implementation.parallelImplementationPreserved ? " · parallel split preserved" : ""}`
    );
    lines.push(
      `     history      ${evolution.couplingRelationshipsCoLocated} coupled pair(s) co-located · ${evolution.couplingRelationshipsStillCrossBoundary} still cross-boundary · ${evolution.couplingRelationshipsPreserved} preserved · ${evolution.couplingRelationshipsUnknown} unknown · ${evolution.hotspotBehaviorRelocated} hotspot module(s) affected · alignment ${evolution.historicalEvidenceAlignment}`
    );
    lines.push(
      `     intent       ${intent.compatibility}${intent.anchorsViolated.length > 0 ? ` · violates ${intent.anchorsViolated.join(", ")}` : ""}${intent.anchorsPreserved.length > 0 ? ` · preserves ${intent.anchorsPreserved.join(", ")}` : ""}${intent.anchoredResponsibilitiesAdded.length > 0 ? ` · anchored gains ${intent.anchoredResponsibilitiesAdded.join("; ")}` : ""}${intent.anchoredResponsibilitiesRemoved.length > 0 ? ` · anchored loses ${intent.anchoredResponsibilitiesRemoved.join("; ")}` : ""}`
    );
    for (const change of analysis.changes) {
      const from = Array.isArray(change.from)
        ? change.from.join(", ")
        : change.from;
      const to = Array.isArray(change.to) ? change.to.join(", ") : change.to;
      lines.push(
        `     Δ ${change.kind.padEnd(34)} ${from === undefined ? "" : String(from)}${from !== undefined && to !== undefined ? " → " : ""}${to === undefined ? "" : String(to)} (${change.certainty})`
      );
    }
    for (const row of analysis.preserved) {
      lines.push(`     = ${row.kind.padEnd(34)} ${row.detail}`);
    }
    for (const row of analysis.uncertainties) {
      lines.push(`     ? ${row.kind.padEnd(34)} ${row.detail}`);
    }
    for (const row of analysis.constraints) {
      lines.push(`     ! ${row.constraint.kind.padEnd(34)} ${row.consequence}`);
    }
  });
  return lines.join("\n");
}

function packagesOf(placement: ScenarioPlacement, responsibility: string) {
  return (
    placement.responsibilities.find(
      (row) => row.responsibility === responsibility
    )?.packages ?? []
  );
}

/** What the scenario changes, in words; never a recommendation. */
function scenarioLine(item: RecenteringScenario): string {
  const home = item.current.semanticCenter;
  switch (item.kind) {
    case "preserve-current":
      return "preserve current";
    case "rehome-semantic-center":
      return `semantic center → ${item.proposed.semanticCenter}`;
    case "rehome-behavior":
      return `behavior → ${home} · semantic contract stays ${home}`;
    case "consolidate-behavior":
      return `consolidate behavior → ${packagesOf(item.proposed, "domain-behavior").join(", ")} · semantic contract stays ${home}`;
    case "formalize-representation-boundary":
      return `formalize representation boundary · conversion in ${packagesOf(item.proposed, "conversion").join(", ")}`;
    case "split-responsibility":
      return `split responsibility · implementation ${packagesOf(item.proposed, "implementation").join(", ") || "—"} · conversion ${packagesOf(item.proposed, "conversion").join(", ") || "—"}`;
  }
}

function currentLine(placement: ScenarioPlacement): string {
  const behavior = packagesOf(placement, "domain-behavior");
  return `semantic center ${placement.semanticCenter}${behavior.length > 0 ? ` · behavior ${behavior.join(", ")}` : ""}`;
}

/** Top findings with their scenarios, in kind precedence. The focused view has placements and rationale. */
function renderScenarioSection(
  report: RecenteringScenarioReport,
  config: AnalysisConfig,
  lines: string[]
): void {
  if (report.findings.length === 0) {
    return;
  }
  const { summary } = report;
  const policy = config.recentering.scenarios.report;
  lines.push("");
  lines.push("RE-CENTERING SCENARIOS");
  lines.push(
    `  ${plural(summary.findings, "finding")} · ${plural(summary.scenarios, "scenario")} (${summary.plausible} plausible · ${summary.constrained} constrained · ${summary.blocked} blocked) · ${summary.findingsWithAlternatives} with alternatives · ${summary.baselineOnly} baseline-only`
  );
  const kinds = Object.entries(summary.byKind).filter(([, count]) => count > 0);
  lines.push(
    `  kinds: ${kinds.map(([kind, count]) => `${count} ${kind}`).join(" · ")}`
  );
  report.findings.slice(0, policy.topFindings).forEach((finding, index) => {
    lines.push(
      `    ${index + 1}. ${finding.subject.name} (${signalLabel(finding.signal)})`
    );
    const current = finding.scenarios[0]?.current;
    if (current !== undefined) {
      lines.push(`       current  ${currentLine(current)}`);
    }
    finding.scenarios
      .slice(0, policy.topScenariosPerFinding)
      .forEach((item, letter) => {
        lines.push(
          `       ${String.fromCharCode(65 + letter)}. ${scenarioLine(item)} · ${item.status} · evidence ${item.confidence}`
        );
      });
    if (finding.scenarios.length > policy.topScenariosPerFinding) {
      lines.push(
        `       … ${finding.scenarios.length - policy.topScenariosPerFinding} more (see --json)`
      );
    }
  });
  if (report.findings.length > policy.topFindings) {
    lines.push(
      `    … ${report.findings.length - policy.topFindings} more (see --json)`
    );
  }
}

function placementLines(
  placement: ScenarioPlacement,
  indent: string
): string[] {
  return [
    `${indent}semantic center     ${placement.semanticCenter}`,
    ...placement.responsibilities.map(
      (row) =>
        `${indent}${row.responsibility.padEnd(19)} ${row.packages.join(", ")}`
    ),
  ];
}

/** Focused view: candidate centers, every scenario with both placements, rationale, constraints, cautions. */
export function renderRecenteringScenarios(
  item: RecenteringScenarioFinding | undefined
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("RE-CENTERING SCENARIOS");
  if (item === undefined) {
    lines.push("  no scenarios (no mis-centering finding)");
    return lines.join("\n");
  }
  lines.push(
    `  candidate centers  ${item.candidateCenters
      .map(
        (center) =>
          `${center.package}${center.anchored ? " ◆" : ""} [${Object.entries(
            center.reasons
          )
            .map(([reason, value]) =>
              typeof value === "number" &&
              value <= 1 &&
              !Number.isInteger(value)
                ? `${reason} ${percent(value)}`
                : value === true
                  ? reason
                  : `${reason} ${value}`
            )
            .join(", ")}]`
      )
      .join(" · ")}`
  );
  const diagnostics = item.diagnostics;
  lines.push(
    `  generation         ${diagnostics.proposed} proposed · ${diagnostics.deduplicated} deduplicated · ${diagnostics.truncated} truncated · ${diagnostics.blocked} blocked${diagnostics.noAlternativeReason === undefined ? "" : ` · ${diagnostics.noAlternativeReason}`}`
  );
  const current = item.scenarios[0]?.current;
  if (current !== undefined) {
    lines.push("  current");
    lines.push(...placementLines(current, "    "));
  }
  item.scenarios.forEach((scenario, index) => {
    lines.push("");
    lines.push(
      `  ${String.fromCharCode(65 + index)}. ${scenarioLine(scenario)}`
    );
    lines.push(
      `     status ${scenario.status} · evidence ${scenario.confidence} · affects ${scenario.affectedResponsibilities.join(", ") || "nothing"}`
    );
    if (scenario.kind !== "preserve-current") {
      lines.push("     proposed");
      lines.push(...placementLines(scenario.proposed, "       "));
    }
    for (const entry of scenario.rationale) {
      lines.push(
        `     + ${entry.kind.padEnd(26)} ${String(entry.detail)}${entry.package === undefined ? "" : ` (${entry.package})`} · supports ${entry.supports}`
      );
    }
    for (const constraint of scenario.constraints) {
      const detail =
        constraint.kind === "anchor"
          ? `${constraint.package}: ${constraint.reason}`
          : constraint.kind === "representation-boundary"
            ? constraint.concepts.join(", ")
            : constraint.kind === "public-contract"
              ? constraint.package
              : constraint.concept;
      lines.push(`     ! ${constraint.kind}: ${detail}`);
    }
    for (const caution of scenario.cautions) {
      lines.push(`     ~ ${caution.kind}: ${caution.detail}`);
    }
  });
  return lines.join("\n");
}

function findingLine(item: MiscenteredConceptFinding): string {
  const home = item.declaredHome.package;
  const centers = item.observedCenters.filter(
    (center) => center.target !== home
  );
  const where =
    item.signal === "external-gravity"
      ? `${home} → gravity toward ${centers[0]?.target ?? "—"}`
      : item.signal === "boundary-drift"
        ? `${home} keeps symbols; behavior in ${centers
            .filter((center) => (center.shares["behavioral-locality"] ?? 0) > 0)
            .map((center) => center.target)
            .join(", ")}`
        : `split across ${item.observedCenters
            .filter((center) => center.gravity >= 0.2)
            .map((center) => center.target)
            .join(" / ")}`;
  return `${where}${item.anchored ? " ◆ anchored" : ""}\n       ${item.signal} · evidence ${percent(item.evidenceConfidence)}`;
}

/** Strongest findings only; the full gravity table is in JSON or the focused view. */
function renderMiscenteredSection(
  report: MiscenteredConceptReport,
  config: AnalysisConfig,
  lines: string[]
): void {
  if (report.summary.evaluated === 0) {
    return;
  }
  const { summary, findings } = report;
  const shown = config.recentering.miscentering.report.topFindings;
  lines.push("");
  lines.push("MIS-CENTERED CONCEPTS");
  lines.push(
    `  ${summary.evaluated} evaluated · ${summary.findings} findings (${summary.bySignal["external-gravity"]} external gravity · ${summary.bySignal["split-gravity"]} split gravity · ${summary.bySignal["boundary-drift"]} boundary drift) · ${summary.anchored} anchored`
  );
  lines.push(
    `  no finding: ${summary.outcomes.aligned} aligned · ${summary.outcomes["behavior-light"]} behavior-light · ${summary.outcomes["usage-only"]} usage-only · ${summary.outcomes.unclear} unclear`
  );
  findings.slice(0, shown).forEach((item, index) => {
    lines.push(`    ${index + 1}. ${item.concept.name}`);
    lines.push(`       ${findingLine(item)}`);
  });
  if (findings.length > shown) {
    lines.push(`    … ${findings.length - shown} more (see --json)`);
  }
}

function signalLabel(signal: MiscenteredConceptFinding["signal"]): string {
  return signal.replace("-", " ");
}

/** Focused view: declared home, every observed center, evidence, cautions. */
export function renderMiscenteredFinding(
  item: MiscenteredConceptFinding | undefined,
  outcome?: MiscenteringOutcome
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("MIS-CENTERING");
  if (item === undefined) {
    lines.push(`  no finding${outcome === undefined ? "" : ` (${outcome})`}`);
    return lines.join("\n");
  }
  const home = item.declaredHome;
  lines.push(
    `  declared home      ${home.package}${home.anchored ? ` ◆ anchored${home.anchorReason === undefined ? "" : ` (${home.anchorReason})`}` : ""} · ${home.module}`
  );
  lines.push(
    `  signal             ${signalLabel(item.signal)} · evidence confidence ${percent(item.evidenceConfidence)} · mismatch ${item.mismatch.toFixed(2)}`
  );
  lines.push(`  supported by       ${item.supportingFamilies.join(" · ")}`);
  lines.push(
    `  gravity            ${item.gravityFamilies.map((family) => `${family} ×${(item.weights[family] ?? 0).toFixed(2)}`).join(" · ")}`
  );
  for (const center of item.observedCenters) {
    const shares = item.gravityFamilies
      .map((family) => `${family} ${percent(center.shares[family] ?? 0)}`)
      .join(" · ");
    lines.push(
      `    ${center.target.padEnd(30)} ${percent(center.gravity).padStart(6)}${center.anchored ? " ◆" : "  "} ${shares}`
    );
  }
  if (item.signal === "split-gravity") {
    lines.push("  interpretation     no dominant structural center detected");
  }
  lines.push("  evidence");
  for (const entry of item.evidence) {
    const value = Array.isArray(entry.value)
      ? entry.value.join(", ")
      : typeof entry.value === "number"
        ? percent(entry.value)
        : entry.value;
    lines.push(
      `    ${entry.supports ? "▲" : " "} ${entry.kind.padEnd(20)} ${entry.metric.padEnd(32)} ${value}${entry.package === undefined ? "" : ` (${entry.package})`} · ${entry.source}`
    );
  }
  for (const caution of item.cautions) {
    lines.push(`  caution  ${caution.kind}: ${caution.detail}`);
  }
  return lines.join("\n");
}

/** Focused view for `--concept`; every tension, evidence item, and caution. */
export function renderRecenteringCandidate(
  item: RecenteringCandidate | undefined
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("RE-CENTERING");
  if (item === undefined) {
    lines.push("  no tension recorded; not evaluated further");
    return lines.join("\n");
  }
  const { currentPlacement: placement, behavior, locality, intent } = item;
  lines.push(
    `  status             ${item.status}${item.shapes.length > 0 ? ` · ${item.shapes.join(" · ")}` : ""}`
  );
  lines.push(
    `  tensions           ${item.tensions.map((tension) => (item.strongTensions.includes(tension) ? `${tension} (strong)` : tension)).join(" · ")}`
  );
  lines.push(`  dimensions         ${item.dimensions.join(" · ")}`);
  lines.push(
    `  placement          seed ${placement.seedPackage} · representation ${placement.representationCenter ?? "—"} · usage ${placement.usageCenter ?? "—"} · evolution ${placement.evolutionCenter ?? "—"} · implementations ${placement.implementationCenters.length > 0 ? placement.implementationCenters.join(", ") : "—"}`
  );
  lines.push(
    `  behavior           ${behavior.strong} strong · ${behavior.weak} weak of ${plural(behavior.source, "source behavior")} · ${Object.entries(
      behavior.byKind
    )
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `${count} ${kind}`)
      .join(
        " · "
      )}${behavior.primaryStrongPackage === undefined ? "" : ` · strong primary ${behavior.primaryStrongPackage} ${percent(behavior.primaryStrongShare ?? 0)}`}`
  );
  for (const row of behavior.byPackage) {
    lines.push(
      `    ${row.package.padEnd(30)} ${row.strong} strong · ${row.weak} weak · ${Object.entries(
        row.byKind
      )
        .filter(([, count]) => count > 0)
        .map(([kind, count]) => `${count} ${kind}`)
        .join(" · ")}`
    );
  }
  lines.push(
    `  locality           ${[locality.shape, ...locality.modifiers].join(" · ")} · ${plural(locality.sourceModules, "module")} · ${plural(locality.sourcePackages, "package")}${locality.topTwoModuleShare === null ? "" : ` · top two modules ${percent(locality.topTwoModuleShare)}`}${behavior.topTwoStrongModuleShare === null ? "" : ` · strong in ${plural(behavior.strongModules, "module")}, top two ${percent(behavior.topTwoStrongModuleShare)}`}${locality.maxModuleDistance === null ? "" : ` · max distance ${locality.maxModuleDistance}`}`
  );
  if (item.history !== undefined) {
    lines.push(
      `  history            ${plural(item.history.hotspotModules, "hotspot module")} · ${plural(item.history.internalSourceCouplings, "source coupling")} · ${plural(item.history.crossPackageCouplings.length, "cross-package coupling")}${item.history.evolutionCenter === undefined ? "" : ` · evolution center ${item.history.evolutionCenter}`}`
    );
  }
  lines.push(
    `  intent             ${intent.seedAnchored ? `seed package anchored${intent.anchorReason === undefined ? "" : ` (${intent.anchorReason})`}` : "seed package not anchored"}${intent.anchoredObservedPackages.length > 0 ? ` · anchored observed: ${intent.anchoredObservedPackages.join(", ")}` : ""}`
  );
  for (const boundary of intent.representationBoundaries) {
    lines.push(
      `    representation boundary ${boundary.overlappingConcept?.name ?? "—"} · converters in ${boundary.converterPackages.join(", ")}${boundary.explicitBidirectionalConversion ? " · bidirectional" : ""}${boundary.structuralOverlap === undefined ? "" : ` · Jaccard ${percent(boundary.structuralOverlap)}`}`
    );
  }
  lines.push("  evidence");
  for (const entry of item.evidence) {
    const value = Array.isArray(entry.value)
      ? entry.value.join(", ")
      : typeof entry.value === "number" &&
          (SHARE_KINDS.has(entry.kind) || !Number.isInteger(entry.value))
        ? percent(entry.value)
        : String(entry.value);
    lines.push(
      `    ${entry.dimension.padEnd(15)} ${entry.kind.padEnd(34)} ${value}${entry.package === undefined ? "" : ` (${entry.package})`} · ${entry.source}`
    );
  }
  for (const caution of item.cautions) {
    lines.push(`  caution  ${caution.kind}: ${caution.detail}`);
  }
  return lines.join("\n");
}
