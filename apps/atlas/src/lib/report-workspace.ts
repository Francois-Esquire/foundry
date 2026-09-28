import { ANALYSIS_CONFIG } from "./config";
import { renderProjectionResult } from "./report-projection";
import type {
  WorkspaceBoundaryConceptLoad,
  WorkspaceConceptDirection,
  WorkspaceConceptDirectionKind,
  WorkspaceConceptIntelligence,
} from "./workspace-concepts-types";
import type {
  WorkspaceGraphAnalysis,
  WorkspaceRankedNode,
} from "./workspace-graph-types";
import type {
  WorkspaceArchitecturalPatterns,
  WorkspaceBoundaryPattern,
  WorkspacePackagePairPattern,
  WorkspacePatternCoverage,
  WorkspacePatternEvidenceStrength,
  WorkspacePatternSupport,
} from "./workspace-patterns-types";
import { createWorkspaceProjectionContext } from "./workspace-projection";
import { queryWorkspace } from "./workspace-projection-views";
import type {
  WorkspaceConflictResolution,
  WorkspaceEntityKind,
  WorkspaceReport,
} from "./workspace-types";

const shortPattern = /^@[^/]+\//;

// Whole-workspace summary: ingestion counts, coverage, conflicts, and the
// V9.1–V9.3 sections. The focused `--package` / `--concept` views render
// V9.4 projections, so they never read the canonical model directly.

const ENTITY_LABELS: [WorkspaceEntityKind, string][] = [
  ["package", "packages"],
  ["module", "modules"],
  ["moduleEdge", "module edges"],
  ["dependencyEdge", "dependency edges"],
  ["boundary", "boundaries"],
  ["concept", "concepts"],
  ["overlap", "overlap pairs"],
  ["churn", "churn files"],
  ["hotspot", "hotspots"],
  ["coupling", "coupling pairs"],
  ["packageCoupling", "package couplings"],
];

function count(n: number): string {
  return n.toLocaleString("en-US");
}

function tally<T extends string>(values: T[]): Map<T, number> {
  const map = new Map<T, number>();
  for (const value of values) {
    map.set(value, (map.get(value) ?? 0) + 1);
  }
  return map;
}

export function renderWorkspaceReport(report: WorkspaceReport): string {
  const { ingestion } = report;
  const lines: string[] = ["WORKSPACE", "═════════", ""];

  lines.push("Reports");
  lines.push(
    `  ${count(ingestion.reportsAccepted)} accepted · ${count(ingestion.reportsRejected)} rejected · ${count(ingestion.duplicates)} duplicate`
  );
  const policies = new Set(
    report.sources.flatMap((s) =>
      s.policyVersion === undefined ? [] : [s.policyVersion]
    )
  );
  const unknownPolicy = report.sources.filter(
    (s) => s.policyVersion === undefined
  ).length;
  const schemas = new Set(report.sources.map((s) => s.schemaVersion));
  lines.push(
    `  schema ${[...schemas].sort((a, b) => a - b).join(", ")} · policy ${
      policies.size === 0
        ? "unknown"
        : [...policies].sort((a, b) => a - b).join(", ")
    }${unknownPolicy > 0 ? ` (${count(unknownPolicy)} unknown)` : ""}`
  );
  lines.push("");

  lines.push("Canonical");
  for (const [kind, label] of ENTITY_LABELS) {
    const naive = ingestion.naive[kind];
    const canonical = ingestion.canonical[kind];
    const density = ingestion.density[kind];
    const dedup =
      naive !== canonical && kind !== "package"
        ? ` (${count(naive)} observed · ${count(density.two + density.threePlus)} seen twice+)`
        : "";
    lines.push(`  ${count(canonical)} ${label}${dedup}`);
  }
  lines.push("");

  const { recentering } = report.architecture;
  lines.push("Architecture");
  lines.push(`  ${count(recentering.findings.length)} re-centering findings`);
  lines.push(`  ${count(recentering.scenarios.length)} scenarios`);
  lines.push(`  ${count(recentering.impacts.length)} scenario impacts`);
  lines.push(`  ${count(recentering.reviews.length)} architecture reviews`);
  const unresolved = [
    ...recentering.scenarios,
    ...recentering.impacts,
    ...recentering.reviews,
  ].filter((item) => !item.resolved).length;
  if (unresolved > 0) {
    lines.push(`  ${count(unresolved)} unresolved references`);
  }
  lines.push("");

  const { coverage } = ingestion;
  lines.push("Coverage");
  lines.push(
    `  ${coverage.complete ? "complete" : "partial"} · ${count(coverage.packagesAnalyzed)} of ${count(coverage.population ?? coverage.packagesKnown)} packages analyzed`
  );
  if (coverage.missingPackages.length > 0) {
    lines.push(`  missing: ${coverage.missingPackages.join(", ")}`);
  }
  lines.push("");

  lines.push("Conflicts");
  const byResolution = tally(ingestion.conflicts.map((c) => c.resolution));
  const order: WorkspaceConflictResolution[] = [
    "target-scoped",
    "preferred-authority",
    "unresolved",
    "identical",
  ];
  lines.push(
    `  ${order
      .map((r) => `${count(byResolution.get(r) ?? 0)} ${r}`)
      .join(" · ")}`
  );
  const byEntity = tally(
    ingestion.conflicts.map((c) => `${c.entity}.${c.field}`)
  );
  for (const [key, n] of [...byEntity.entries()].sort()) {
    lines.push(`  ${count(n)} ${key}`);
  }
  lines.push("");

  lines.push("Diagnostics");
  const byKind = tally(ingestion.diagnostics.map((d) => d.kind));
  if (byKind.size === 0) {
    lines.push("  none");
  }
  for (const [kind, n] of [...byKind.entries()].sort()) {
    lines.push(`  ${count(n)} ${kind}`);
  }

  const graph = report.intelligence?.graph;
  if (graph !== undefined) {
    lines.push("", ...renderGraphSection(graph));
  }
  const concepts = report.intelligence?.concepts;
  if (concepts !== undefined) {
    lines.push("", ...renderConceptSection(concepts));
  }
  const patterns = report.intelligence?.patterns;
  if (patterns !== undefined) {
    lines.push("", ...renderPatternSection(patterns));
  }

  return lines.join("\n");
}

const STRENGTH_ORDER: WorkspacePatternEvidenceStrength[] = [
  "strong",
  "moderate",
  "limited",
];

function byStrength<T extends { strength: WorkspacePatternEvidenceStrength }>(
  a: T,
  b: T
): number {
  return (
    STRENGTH_ORDER.indexOf(a.strength) - STRENGTH_ORDER.indexOf(b.strength)
  );
}

function supportLine(
  support: WorkspacePatternSupport,
  strength: WorkspacePatternEvidenceStrength,
  coverage: WorkspacePatternCoverage
): string {
  return `${count(support.conceptCount)} ${plural(support.conceptCount, "concept")} · ${strength} · ${coverage} coverage`;
}

/** Strong and moderate patterns only; limited ones stay in the JSON. */
function renderPatternSection(
  patterns: WorkspaceArchitecturalPatterns
): string[] {
  const policy = ANALYSIS_CONFIG.workspacePatterns.report;
  const shown = (strength: WorkspacePatternEvidenceStrength) =>
    strength !== "limited";
  const lines: string[] = [
    "WORKSPACE ARCHITECTURE",
    "══════════════════════",
    "",
  ];
  const { summary } = patterns;
  lines.push("Patterns");
  lines.push(
    `  ${count(summary.packageRoles)} package roles · ${count(summary.packagePairPatterns)} pair patterns · ${count(summary.boundaryPatterns)} boundary patterns · ${count(summary.conceptPatterns)} concept patterns · ${count(summary.evolutionaryPatterns)} evolutionary`
  );
  lines.push(
    `  ${count(summary.strong)} strong · ${count(summary.moderate)} moderate · ${count(summary.limited)} limited · ${patterns.certainty} coverage`
  );
  lines.push("");

  lines.push("Package roles");
  const withRoles = patterns.packages
    .filter((p) => p.roles.some((r) => shown(r.strength)))
    .slice(0, policy.topPackages);
  if (withRoles.length === 0) {
    lines.push("  none");
  }
  const visitPkg = () => {
    for (const pkg of withRoles) {
      lines.push(`  ${short(pkg.package)}`);
      for (const role of pkg.roles.filter((r) => shown(r.strength))) {
        const sources =
          role.kind === "semantic-center"
            ? `${count(pkg.counts.directionTargets)} ${plural(pkg.counts.directionTargets, "target package")}`
            : `from ${count(role.sourcePackages.length)} ${plural(role.sourcePackages.length, "package")}`;
        lines.push(
          `    ${role.kind.padEnd(22)} ${count(role.support.conceptCount)} ${plural(role.support.conceptCount, "concept")} · ${sources} · ${role.strength}`
        );
      }
    }
  };
  visitPkg();
  lines.push("");

  lines.push("Repeated directions");
  const pairs = patterns.packagePairs
    .filter((p) => p.patterns.length > 0 && shown(p.strength))
    .sort((a, b) => b.conceptCount - a.conceptCount || byStrength(a, b))
    .slice(0, policy.topPairs);
  if (pairs.length === 0) {
    lines.push("  none");
  }
  const visitPair = () => {
    for (const pair of pairs) {
      const roles = [
        ["impl", pair.conceptRoles.implementation.length],
        ["behavior", pair.conceptRoles.behavior.length],
        ["repr", pair.conceptRoles.representation.length],
        ["use", pair.conceptRoles.usage.length],
        ["conv", pair.conceptRoles.conversion.length],
      ] as const;
      lines.push(
        `  ${short(pair.from)} → ${short(pair.to)} · ${pair.patterns.join(", ")}`
      );
      lines.push(
        `    ${roles.map(([label, n]) => `${label} ${count(n)}`).join(" · ")} · static ${resolveVisitPair(pair)}${pair.reviews === undefined ? "" : ` · reviewed ${count(pair.reviews.reviewed)} (${count(pair.reviews.dominatedBaselines.length)} dominated baselines)`}`
      );
    }
  };
  visitPair();
  lines.push("");

  lines.push("Boundary patterns");
  const boundaries = [...patterns.boundaries]
    .filter((b) => shown(b.strength))
    .sort((a, b) => b.conceptLoad - a.conceptLoad || byStrength(a, b))
    .slice(0, policy.topBoundaries);
  if (boundaries.length === 0) {
    lines.push("  none");
  }
  renderPatternSectionBoundary(boundaries, lines);
  lines.push("");

  lines.push("Concept patterns");
  const concepts = [...patterns.conceptPatterns]
    .filter((c) => shown(c.strength))
    .sort(byStrength)
    .slice(0, policy.topConceptPatterns);
  if (concepts.length === 0) {
    lines.push("  none");
  }
  for (const pattern of concepts) {
    lines.push(`  ${pattern.kind} · ${pattern.packages.map(short).join(", ")}`);
    lines.push(
      `    ${supportLine(pattern.support, pattern.strength, pattern.coverage)}`
    );
  }
  lines.push("");

  lines.push("Evolutionary patterns");
  const evolution = [...patterns.evolutionaryPatterns]
    .filter((e) => shown(e.strength))
    .sort((a, b) => b.couplings.length - a.couplings.length);
  if (evolution.length === 0) {
    lines.push("  none");
  }
  for (const pattern of evolution) {
    lines.push(
      `  ${pattern.packages.map(short).join(" ↔ ")} · ${pattern.kinds.join(", ")} · ${count(pattern.couplings.length)} ${plural(pattern.couplings.length, "coupling")} · ${count(pattern.coChangeCommits)} commits`
    );
  }
  lines.push("");

  lines.push("Review patterns");
  const centers = patterns.reviewPatterns.filter(
    (r) => r.scope === "gravity-center"
  );
  if (centers.length === 0) {
    lines.push("  none");
  }
  for (const pattern of centers) {
    const dispositions = Object.entries(pattern.reviews.dispositions)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([kind, n]) => `${count(n)} ${kind}`)
      .join(" · ");
    lines.push(
      `  gravity ${short(pattern.id)} · ${dispositions} · ${count(pattern.reviews.dominatedBaselines.length)} dominated baselines`
    );
  }
  lines.push("");

  lines.push("Statements");
  if (patterns.statements.length === 0) {
    lines.push("  none");
  }
  for (const statement of patterns.statements) {
    lines.push(`  ${statement.detail}`);
  }

  lines.push("", "Analysis gaps");
  if (patterns.coveragePatterns.length === 0) {
    lines.push("  none");
  }
  for (const gap of patterns.coveragePatterns) {
    const entities =
      gap.entities.length > 0 && gap.entities.length <= 3
        ? ` · ${gap.entities.map(short).join(", ")}`
        : "";
    lines.push(`  ${gap.kind} · ${count(gap.count)}${entities}`);
  }
  if (patterns.cautions.length > 0) {
    lines.push("", "Cautions");
    for (const caution of patterns.cautions) {
      lines.push(`  ${caution.kind}`);
    }
  }
  return lines;
}

const DIRECTION_LABELS: [WorkspaceConceptDirectionKind, string][] = [
  ["semantic-to-implementation", "implementation"],
  ["semantic-to-behavior", "behavior"],
  ["semantic-to-representation", "representation"],
  ["semantic-to-usage", "usage"],
  ["semantic-to-conversion", "conversion"],
];

function resolveVisitPair(
  pair: WorkspacePackagePairPattern
): "none" | "reverse" | "forward" {
  if (pair.graph.forward === null) {
    if (pair.graph.reverse === null) {
      return "none";
    }
    return "reverse";
  }
  return "forward";
}

function renderPatternSectionBoundary(
  boundaries: WorkspaceBoundaryPattern[],
  lines: string[]
) {
  for (const boundary of boundaries) {
    lines.push(
      `  ${short(boundary.from)}→${short(boundary.to)} · ${boundary.kinds.join(", ")}`
    );
    lines.push(
      `    ${count(boundary.conceptLoad)} ${plural(boundary.conceptLoad, "concept")} · ${count(boundary.graph.importSites ?? boundary.graph.moduleEdges)} ${boundary.graph.importSites === null ? "module edges" : "import sites"} · severs ${count(boundary.graph.severedPairs)} · ${count(boundary.evolution.couplings.length)} ${plural(boundary.evolution.couplings.length, "coupling")}`
    );
  }
}

function directionLine(direction: WorkspaceConceptDirection): string {
  const label =
    DIRECTION_LABELS.find(([kind]) => kind === direction.kind)?.[1] ??
    direction.kind;
  let path:
    | "usage-only"
    | "no static path"
    | "static reverse"
    | "static forward";
  if (direction.dependencyPath.forward === null) {
    if (direction.dependencyPath.reverse === null) {
      if (direction.dependencyPath.usageOnly) {
        path = "usage-only";
      } else {
        path = "no static path";
      }
    } else {
      path = "static reverse";
    }
  } else {
    path = "static forward";
  }
  return `  ${short(direction.from)} → ${short(direction.to)} · ${label.padEnd(14)} ${count(direction.count)} ${plural(direction.count, "concept")} · ${path}`;
}

function loadLine(load: WorkspaceBoundaryConceptLoad): string {
  const { roles } = load;
  return `  ${short(load.from)}→${short(load.to)} · ${count(load.conceptCount)} ${plural(load.conceptCount, "concept")} · use ${count(roles.semanticUse)} · behavior ${count(roles.behavior)} · impl ${count(roles.implementation)} · repr ${count(roles.representation)} · ${count(load.volume.importSites ?? load.volume.moduleEdges)} ${load.volume.importSites === null ? "module edges" : "import sites"} · severs ${count(load.structure.severedPairs)}`;
}

function renderConceptSection(
  concepts: WorkspaceConceptIntelligence
): string[] {
  const policy = ANALYSIS_CONFIG.workspaceConcepts.report;
  const { summary } = concepts;
  const lines: string[] = ["WORKSPACE CONCEPTS", "══════════════════", ""];

  lines.push("Concepts");
  lines.push(
    `  ${count(summary.concepts)} canonical · ${count(summary.authoritative)} authoritative · ${count(summary.partial)} partial · ${count(summary.foreignOnly)} foreign-only`
  );
  lines.push(
    `  ${count(summary.local)} local · ${count(summary.crossPackage)} cross-package · ${count(summary.parallelImplementation)} parallel-implementation · ${count(summary.downstreamImplemented)} downstream-implemented`
  );
  lines.push(
    `  ${count(summary.upstreamConsumed)} upstream-consumed · ${count(summary.crossLayer)} cross-layer · ${count(summary.representationSplit)} representation-split · ${count(summary.multiRegion)} multi-region`
  );
  lines.push(
    `  ${count(summary.families)} contract families · ${count(summary.overlapPairs)} overlap pairs · ${count(summary.conversionPairs)} conversion pairs`
  );
  lines.push("");

  lines.push("Roles");
  const rows = concepts.packageRoles.filter(
    (r) => r.declaredConcepts > 0 || r.participating.total > 0
  );
  const top = (key: (r: (typeof rows)[number]) => number, label: string) => {
    const ranked = rows
      .filter((r) => key(r) > 0)
      .sort((a, b) => key(b) - key(a) || (a.package < b.package ? -1 : 1))
      .slice(0, 3);
    lines.push(
      `  ${label.padEnd(16)}${ranked.length === 0 ? "none" : ranked.map((r) => `${short(r.package)} ${count(key(r))}`).join(" · ")}`
    );
  };
  top((r) => r.declaredConcepts, "declared");
  top((r) => r.implementationCenters, "impl centers");
  top((r) => r.behaviorCenters, "behavior centers");
  top((r) => r.representationCenters, "repr centers");
  top((r) => r.usageCenters, "usage centers");
  top((r) => r.participating.converting, "converting");
  lines.push("");

  lines.push("Directions");
  for (const [kind] of DIRECTION_LABELS) {
    const ranked = concepts.directions
      .filter((d) => d.kind === kind)
      .slice(0, Math.max(1, Math.floor(policy.topDirections / 5)));
    for (const direction of ranked) {
      lines.push(directionLine(direction));
    }
  }
  lines.push("");

  lines.push("Boundaries");
  lines.push(
    `  ${count(summary.conceptBearingBoundaries)} concept-bearing · ${count(concepts.seams.length)} seams`
  );
  for (const load of concepts.boundaries.slice(0, policy.topBoundaries)) {
    lines.push(loadLine(load));
  }
  lines.push("");

  lines.push("Representative concepts");
  const representative = concepts.concepts
    .filter((c) => c.coverage === "authoritative")
    .sort(
      (a, b) =>
        b.span.boundaryCount - a.span.boundaryCount ||
        b.presence.packages.length - a.presence.packages.length ||
        (a.concept.id < b.concept.id ? -1 : 1)
    )
    .slice(0, policy.topConcepts);
  for (const placement of representative) {
    lines.push(
      `  ${placement.concept.name} (${short(placement.concept.package)}) · ${count(placement.presence.packages.length)} packages · ${count(placement.span.boundaryCount)} boundaries · ${placement.shapes.join(", ") || "no shape"}`
    );
  }

  if (concepts.cautions.length > 0) {
    lines.push("", "Cautions");
    for (const caution of concepts.cautions) {
      lines.push(`  ${caution.kind}`);
    }
  }
  return lines;
}

/**
 * One concept's place in the workspace, rendered from its V9.4 projection.
 * `key` is an id or a display name; an ambiguous name lists the candidates.
 */
export function renderWorkspaceConcept(
  report: WorkspaceReport,
  key: string
): string {
  if (report.intelligence?.concepts === undefined) {
    return "no concept intelligence attached";
  }
  const context = createWorkspaceProjectionContext(report);
  return renderProjectionResult(
    queryWorkspace(context, { id: key, kind: "concept" })
  );
}

function short(id: string): string {
  return id.replace(shortPattern, "");
}

function rankedLine(label: string, nodes: WorkspaceRankedNode[], digits = 0) {
  if (nodes.length === 0) {
    return `  ${label.padEnd(12)}none`;
  }
  return `  ${label.padEnd(12)}${nodes
    .slice(0, 3)
    .map((n) => `${short(n.id)} ${n.value.toFixed(digits)}`)
    .join(" · ")}`;
}

function renderGraphSection(graph: WorkspaceGraphAnalysis): string[] {
  const policy = ANALYSIS_CONFIG.workspaceGraph.report;
  const { topology, summary, layers, centers, reachability } = graph;
  const lines: string[] = ["WORKSPACE GRAPH", "═══════════════", ""];

  lines.push("Packages");
  lines.push(
    `  ${count(topology.packageNodes)} nodes · ${count(topology.packageEdges)} edges · ${graph.certainty} coverage`
  );
  lines.push(
    `  ${count(topology.connectedComponents)} weak ${plural(topology.connectedComponents, "component")} (${topology.packageComponents
      .map((c) => count(c.size))
      .join(
        ", "
      )}) · ${count(summary.cycles)} package ${plural(summary.cycles, "cycle")}`
  );
  lines.push(
    `  ${count(summary.sources)} sources · ${count(summary.sinks)} sinks · ${count(topology.packageIsolated.length)} isolated · ${count(topology.articulationPackages.length)} articulation`
  );
  lines.push("");

  lines.push("Modules");
  lines.push(
    `  ${count(topology.moduleNodes)} nodes · ${count(topology.moduleEdges)} edges · ${count(graph.cycles.moduleCycles)} ${plural(graph.cycles.moduleCycles, "cycle")}`
  );
  lines.push("");

  lines.push("Depth");
  lines.push(
    `  max package chain ${count(layers.maxPackageDepth)} · max module chain ${count(layers.maxModuleDepth)}`
  );
  for (const chain of reachability.longestPackageChains.slice(0, 2)) {
    lines.push(`  ${chain.map(short).join(" → ")}`);
  }
  lines.push("");

  lines.push("Centers");
  lines.push(rankedLine("fan-in", centers.highFanInPackages));
  lines.push(rankedLine("fan-out", centers.highFanOutPackages));
  lines.push(rankedLine("dependents", centers.highDependentReachPackages));
  lines.push(rankedLine("betweenness", centers.bridgePackages, 3));
  lines.push("");

  lines.push("Seams");
  lines.push(
    `  ${count(summary.seams)} structural ${plural(summary.seams, "seam")}`
  );
  for (const seam of graph.seams.slice(0, policy.topSeams)) {
    lines.push(
      `  ${short(seam.from)}→${short(seam.to)} · severs ${count(seam.severedPairs)} · ${count(seam.upstreamPackages)} up · ${count(seam.downstreamPackages)} down${seam.weakBridge ? " · weak bridge" : ""}`
    );
  }
  lines.push("");

  lines.push("Corridors");
  lines.push(
    `  ${count(summary.corridors)} shared shortest-route ${plural(summary.corridors, "corridor")}`
  );
  for (const corridor of graph.corridors.slice(0, policy.topCorridors)) {
    lines.push(
      `  ${corridor.packages.map(short).join(" → ")} · ${count(corridor.support)} ${plural(corridor.support, "pair")}`
    );
  }

  if (graph.cautions.length > 0) {
    lines.push("", "Cautions");
    for (const caution of graph.cautions) {
      lines.push(`  ${caution.kind}`);
    }
  }
  return lines;
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

/** One package's place in the workspace, rendered from its V9.4 projection. */
export function renderWorkspacePackageGraph(
  report: WorkspaceReport,
  id: string
): string {
  if (report.intelligence?.graph === undefined) {
    return "no graph analysis attached";
  }
  const context = createWorkspaceProjectionContext(report);
  return renderProjectionResult(
    queryWorkspace(context, { id, kind: "package" })
  );
}
