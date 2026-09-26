import type {
  ConceptDirectionProjection,
  ProjectionCoverage,
  WorkspaceBoundaryProjection,
  WorkspaceConceptGraphProjection,
  WorkspaceConceptProjection,
  WorkspaceConceptSummaryProjection,
  WorkspaceDirectionListProjection,
  WorkspaceGraphProjection,
  WorkspaceLimitationProjection,
  WorkspaceMatrixProjection,
  WorkspaceOverviewProjection,
  WorkspacePackageProjection,
  WorkspacePackageSummaryProjection,
  WorkspacePatternProjection,
  WorkspaceQueryResult,
  WorkspaceRankProjection,
  WorkspaceReviewContextProjection,
  WorkspaceReviewListProjection,
  WorkspaceReviewProjection,
  WorkspaceSearchProjection,
} from "./workspace-projection-types";

// Text renderers over V9.4 projection objects. Formatting only: every
// value printed is read from the projection, so nothing here reaches into
// the canonical workspace model or restates an architectural reading.

function count(n: number): string {
  return n.toLocaleString("en-US");
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

function short(id: string): string {
  return id.replace(/^@[^/]+\//, "");
}

function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function title(text: string): string[] {
  return [text, "".padEnd(text.length, "═"), ""];
}

function coverageLine(coverage: ProjectionCoverage): string {
  const missing =
    coverage.missingPackages.length > 0
      ? ` · missing ${coverage.missingPackages.map(short).join(", ")}`
      : "";
  return `Coverage ${coverage.certainty} · ${count(coverage.packagesAnalyzed)} / ${count(coverage.packagesKnown)} packages analyzed${missing}`;
}

function cautionLines(cautions: WorkspaceLimitationProjection[]): string[] {
  if (cautions.length === 0) {
    return [];
  }
  return ["", "Cautions", ...cautions.map((c) => `  ${c.kind} · ${c.detail}`)];
}

function directionLine(d: ConceptDirectionProjection): string {
  return `  ${short(d.from)} → ${short(d.to)} · ${d.role.padEnd(14)} ${count(d.count)} ${plural(d.count, "concept")} · static ${d.staticDependencyDirection}`;
}

function reviewContextLine(r: WorkspaceReviewContextProjection): string {
  const dispositions = Object.entries(r.dispositions)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([kind, n]) => `${count(n)} ${kind}`)
    .join(" · ");
  return `${count(r.reviewed)} reviewed · ${dispositions} · ${count(r.dominatedBaselines.length)} dominated baselines`;
}

export function renderOverview(o: WorkspaceOverviewProjection): string {
  const lines = title("WORKSPACE OVERVIEW");
  const w = o.workspace;
  lines.push(
    `  ${count(w.packages)} packages · ${count(w.modules)} modules · ${count(w.concepts)} concepts (${count(w.authoritativeConcepts)} authoritative) · ${count(w.boundaries)} boundaries (${count(w.conceptBearingBoundaries)} concept-bearing)`
  );
  lines.push(`  ${coverageLine(o.coverage)}`);
  lines.push("", "Topology");
  const t = o.topology;
  lines.push(
    `  ${count(t.sources.length)} sources · ${count(t.sinks.length)} sinks · ${count(t.components)} ${plural(t.components, "component")} · ${count(t.cycles)} ${plural(t.cycles, "cycle")} · max depth ${count(t.maxDepth)} · ${count(t.seams.length)} ${plural(t.seams.length, "seam")}`
  );
  if (t.seams.length > 0) {
    lines.push(`  seams ${t.seams.map(short).join(", ")}`);
  }
  lines.push("", "Package roles");
  if (o.architecture.packageRoles.length === 0) {
    lines.push("  none");
  }
  for (const role of o.architecture.packageRoles) {
    lines.push(
      `  ${short(role.entityId).padEnd(16)} ${role.kinds.join(", ").padEnd(22)} ${count(role.count)} ${plural(role.count, "concept")} · ${role.strength ?? ""}`
    );
  }
  lines.push("", "Concept patterns");
  if (o.architecture.conceptPatterns.length === 0) {
    lines.push("  none");
  }
  for (const p of o.architecture.conceptPatterns) {
    lines.push(
      `  ${p.kinds.join(", ").padEnd(38)} ${count(p.count)} ${plural(p.count, "concept")} · ${p.strength ?? ""} · ${p.entityId}`
    );
  }
  lines.push("", "Boundary patterns");
  if (o.architecture.boundaryPatterns.length === 0) {
    lines.push("  none");
  }
  for (const p of o.architecture.boundaryPatterns) {
    lines.push(
      `  ${short(p.entityId).padEnd(28)} ${p.kinds.join(", ")} · ${count(p.count)} ${plural(p.count, "concept")} · ${p.strength ?? ""}`
    );
  }
  lines.push("", "Statements");
  if (o.architecture.statements.length === 0) {
    lines.push("  none");
  }
  for (const s of o.architecture.statements) {
    lines.push(`  ${s.detail}`);
  }
  lines.push("", "Reviews");
  const r = o.reviews;
  lines.push(
    `  ${count(r.reviewed)} reviewed · ${count(r.preserveCurrent)} preserve-current · ${count(r.credibleAlternatives)} credible-alternative · ${count(r.tradeoffs)} multiple-tradeoffs · ${count(r.intentBlocked)} intent-blocked · ${count(r.insufficientEvidence)} insufficient-evidence · ${count(r.dominatedBaselines)} dominated baselines`
  );
  lines.push("", "Limitations");
  if (o.limitations.length === 0) {
    lines.push("  none");
  }
  for (const l of o.limitations) {
    lines.push(`  ${l.kind} · ${l.detail}`);
  }
  return lines.join("\n");
}

export function renderPackage(p: WorkspacePackageProjection): string {
  const lines = title(p.package);
  const flags = [
    p.analyzed ? "" : "not analyzed",
    p.anchored
      ? `anchored${p.anchorReason === undefined ? "" : ` (${p.anchorReason})`}`
      : "",
  ].filter((f) => f !== "");
  if (flags.length > 0) {
    lines.push(`  ${flags.join(" · ")}`);
  }
  if (p.graph !== undefined) {
    const g = p.graph;
    lines.push(
      `  role ${g.role} · layer ${count(g.layer)} · component ${g.component}${g.cycle ? " · cycle" : ""}${g.articulation ? " · articulation" : ""}`
    );
    lines.push(
      `  fan-in ${count(g.fanIn)} · fan-out ${count(g.fanOut)} · dependents ${count(g.dependentReach)} (${percent(g.dependentReachShare)}) · dependencies ${count(g.dependencyReach)} (${percent(g.dependencyReachShare)}) · betweenness ${g.betweenness.toFixed(3)}`
    );
  }
  if (p.surface !== undefined) {
    const s = p.surface;
    lines.push(
      `  surface ${count(s.packagePublicSymbols)} package-public · ${count(s.externallyUsedSymbols)} used externally (${percent(s.exportUtilization)}) · ${count(s.consumerPackages)} consumers · ${count(s.dependencyPackages)} dependencies${s.shapeSignals.length > 0 ? ` · ${s.shapeSignals.join(", ")}` : ""}`
    );
  }
  if (p.profileSignals.length > 0) {
    lines.push(`  profile ${p.profileSignals.join(", ")}`);
  }
  lines.push(`  ${coverageLine(p.coverage)}`);
  lines.push("", "Architectural roles");
  if (p.roles.length === 0) {
    lines.push("  none");
  }
  for (const role of p.roles) {
    lines.push(
      `  ${role.kind.padEnd(22)} ${count(role.conceptCount)} ${plural(role.conceptCount, "concept")} · from ${role.sourcePackages.map(short).join(", ")} · ${role.strength} · ${role.coverage} coverage`
    );
  }
  const c = p.concepts;
  lines.push("", "Concepts");
  lines.push(
    `  declared ${count(c.declared)} (${count(c.declaredCrossPackage)} cross-package) · centers: semantic ${count(c.semanticCenters)} · implementation ${count(c.implementationCenters)} · behavior ${count(c.behaviorCenters)} · representation ${count(c.representationCenters)} · usage ${count(c.usageCenters)}`
  );
  lines.push(
    `  participating ${count(c.participating.total)} · implementing ${count(c.participating.implementing)} · behaving ${count(c.participating.behaving)} · representing ${count(c.participating.representing)} · using ${count(c.participating.using)} · converting ${count(c.participating.converting)}`
  );
  lines.push(
    `  foreign: implemented ${count(c.foreign.implemented)} · behaved ${count(c.foreign.behaved)} · represented ${count(c.foreign.represented)} · used ${count(c.foreign.used)} · converted ${count(c.foreign.converted)} · from ${count(c.foreign.sources)} ${plural(c.foreign.sources, "package")} · conversions owned ${count(c.conversionsOwned)}`
  );
  lines.push("", "Incoming directions (declared elsewhere, role here)");
  if (p.incomingDirections.length === 0) {
    lines.push("  none");
  }
  for (const d of p.incomingDirections) {
    lines.push(directionLine(d));
  }
  lines.push("", "Outgoing directions (declared here, role elsewhere)");
  if (p.outgoingDirections.length === 0) {
    lines.push("  none");
  }
  for (const d of p.outgoingDirections) {
    lines.push(directionLine(d));
  }
  lines.push("", "Boundaries");
  if (p.boundaries.length === 0) {
    lines.push("  none");
  }
  for (const b of p.boundaries) {
    lines.push(
      `  ${b.direction === "outgoing" ? "→ " + short(b.to) : "← " + short(b.from)} · ${count(b.conceptCount)} ${plural(b.conceptCount, "concept")} · ${b.importSites === null ? `${count(b.moduleEdges)} module edges` : `${count(b.importSites)} import sites`}${b.severedPairs === null ? "" : ` · severs ${count(b.severedPairs)}`}${b.seam ? " · seam" : ""}${b.patterns.length > 0 ? ` · ${b.patterns.join(", ")}` : ""}`
    );
  }
  lines.push("", "Patterns");
  if (p.patterns.length === 0) {
    lines.push("  none");
  }
  for (const id of p.patterns) {
    lines.push(`  ${id}`);
  }
  const r = p.reviews;
  if (
    r.asDeclaringPackage !== undefined ||
    r.asGravityCenter !== undefined ||
    r.directions.length > 0
  ) {
    lines.push("", "Review context");
    if (r.asDeclaringPackage !== undefined) {
      lines.push(
        `  as declaring package · ${reviewContextLine(r.asDeclaringPackage)}`
      );
    }
    if (r.asGravityCenter !== undefined) {
      lines.push(
        `  as gravity center · ${reviewContextLine(r.asGravityCenter)}`
      );
    }
    for (const d of r.directions) {
      lines.push(
        `  ${short(d.from)} → ${short(d.to)} · ${reviewContextLine(d.reviews)}`
      );
    }
  }
  lines.push(...cautionLines(p.cautions));
  if (p.evidenceRefs !== undefined) {
    lines.push(...evidenceLines(p.evidenceRefs));
  }
  return lines.join("\n");
}

function evidenceLines(
  refs: WorkspacePackageProjection["evidenceRefs"]
): string[] {
  if (refs === undefined || refs.length === 0) {
    return [];
  }
  return [
    "",
    "Evidence",
    ...refs.map(
      (r) =>
        `  ${r.source.padEnd(10)} ${r.kind.padEnd(28)} ${r.entityIds.length <= 4 ? r.entityIds.join(", ") : `${count(r.entityIds.length)} entities`}${r.value === undefined ? "" : ` · ${String(r.value)}`}`
    ),
  ];
}

export function renderPackageSummary(
  s: WorkspacePackageSummaryProjection
): string {
  const lines = title(s.package);
  lines.push(
    `  ${s.roles.length === 0 ? "no architectural role" : s.roles.map((r) => `${r.kind} ${count(r.conceptCount)} (${r.strength})`).join(" · ")}`
  );
  lines.push(
    `  declared ${count(s.concepts.declared)} · participating ${count(s.concepts.participating)} · directions in ${count(s.directions.incoming)} / out ${count(s.directions.outgoing)} · ${count(s.boundaries)} boundaries · ${count(s.patterns)} patterns · ${count(s.reviewed)} reviewed`
  );
  lines.push(`  ${coverageLine(s.coverage)}`);
  if (s.cautions.length > 0) {
    lines.push(`  cautions ${s.cautions.join(", ")}`);
  }
  return lines.join("\n");
}

export function renderConcept(c: WorkspaceConceptProjection): string {
  const lines = title(`${c.concept.name} · ${c.concept.id}`);
  lines.push(
    `  ${c.coverage} · ${c.shapes.join(", ") || "no shape"} · propagation ${c.propagation}`
  );
  lines.push("", "Centers");
  if (c.centers === undefined) {
    lines.push("  unavailable");
  } else {
    const at = (pkg: string | undefined, layer: number | undefined) =>
      pkg === undefined
        ? "—"
        : `${short(pkg)}${layer === undefined ? "" : ` (L${layer})`}`;
    lines.push(
      `  semantic ${at(c.centers.semantic, c.centers.layers.semantic)} · representation ${at(c.centers.representation, c.centers.layers.representation)} · usage ${at(c.centers.usage, c.centers.layers.usage)} · behavior ${at(c.centers.behavior, c.centers.layers.behavior)} · evolution ${c.centers.evolution === undefined ? "—" : short(c.centers.evolution)}`
    );
    lines.push(
      `  implementations ${c.centers.implementations.length === 0 ? "none" : c.centers.implementations.map(short).join(", ")}`
    );
  }
  if (c.ownership !== undefined) {
    lines.push(
      `  ownership ${c.ownership.alignment}${c.ownership.tensions.length > 0 ? ` · tensions ${c.ownership.tensions.join(", ")}` : ""}`
    );
  }
  if (c.distribution !== undefined) {
    const d = c.distribution;
    const share = (label: string, s: typeof d.references) =>
      s === null
        ? ""
        : ` · ${label} ${short(s.package)} ${s.count === null ? "" : `${count(s.count)}/`}${count(s.total)} (${percent(s.share)})`;
    lines.push(
      `  distribution ${count(d.packages)} packages · ${count(d.modules)} modules${share("references", d.references)}${share("representations", d.representations)}${share("source behavior", d.sourceBehavior)}`
    );
  }
  if (c.locality !== undefined) {
    const l = c.locality;
    lines.push(
      `  locality ${[l.shape, ...l.modifiers].join(" · ")} · ${count(l.sourceModuleCount)}/${count(l.moduleCount)} source modules · ${count(l.packageCount)} packages · ${count(l.packageBoundaryCount)} boundary edges${l.anchored ? " · anchored" : ""}`
    );
    lines.push(
      `  behavior ${count(l.behavior.source)} source · ${count(l.behavior.test)} test · ${count(l.behavior.story)} story · ${count(l.behavior.contract)} contract · ${count(l.behavior.implementation)} implementation · ${count(l.behavior.conversion)} conversion`
    );
  }
  lines.push("", "Participation");
  for (const p of c.participation) {
    lines.push(
      `  ${short(p.package).padEnd(18)}${(p.roles.join(", ") || "evidence only").padEnd(40)} ${p.layer === null ? "" : `L${p.layer} · `}repr ${count(p.representations)} · impl ${count(p.implementations)} · refs ${count(p.references)} · conv ${count(p.conversions)} · behavior ${count(p.sourceBehaviors)}s/${count(p.testBehaviors)}t/${count(p.storyBehaviors)}y (${count(p.contractBehaviors)} contract · ${count(p.implementationBehaviors)} implementation · ${count(p.conversionBehaviors)} conversion)`
    );
  }
  lines.push("", "Span");
  const s = c.span;
  lines.push(
    `  ${count(s.packages)} packages · layers ${s.minLayer ?? "—"}–${s.maxLayer ?? "—"} · usage span ${s.usageLayerSpan ?? "—"} · responsibility span ${s.responsibilityLayerSpan ?? "—"} · ${count(s.boundaryCount)} boundaries · ${count(s.disconnectedRegions)} ${plural(s.disconnectedRegions, "region")}`
  );
  lines.push("", "Flow (each role package relative to the declared package)");
  const flows: [
    string,
    WorkspaceConceptProjection["flow"]["semanticToBehavior"],
  ][] = [
    ["implementation", c.flow.semanticToImplementations],
    ["behavior", c.flow.semanticToBehavior],
    ["representation", c.flow.semanticToRepresentations],
    ["usage", c.flow.semanticToUsage],
    ["conversion", c.flow.semanticToConversions],
  ];
  for (const [label, paths] of flows) {
    if (paths.length === 0) {
      continue;
    }
    lines.push(
      `  ${label.padEnd(16)}${paths
        .map(
          (p) =>
            `${short(p.package)} ${p.relation}${p.distance === null ? "" : ` ${count(p.distance)}`}${p.usageOnly ? " (usage-only)" : ""}`
        )
        .join(" · ")}`
    );
  }
  lines.push("", "Boundaries");
  if (c.topology.edges.length === 0) {
    lines.push("  none");
  }
  for (const e of c.topology.edges) {
    lines.push(
      `  ${short(e.from)}→${short(e.to)} · ${e.roles.join(", ")} · ${e.importSites === null ? `${count(e.moduleEdges)} module edges` : `${count(e.importSites)} import sites`} · severs ${count(e.severedPairs)}${e.seam ? " · seam" : ""}`
    );
  }
  lines.push("", "Relationships");
  if (c.relationships.overlaps.length === 0) {
    lines.push("  none");
  }
  for (const rel of c.relationships.overlaps) {
    const converters = [
      ...new Set(
        rel.conversions.map((x) =>
          x.package === null ? "?" : short(x.package)
        )
      ),
    ];
    lines.push(
      `  ${rel.otherName} (${short(rel.otherPackage)}) · ${rel.shapes.join(", ")}${converters.length > 0 ? ` · converters ${converters.join(", ")}` : ""}${rel.path === undefined ? "" : ` · path ${rel.path.forward ?? "—"}/${rel.path.reverse ?? "—"}${rel.path.directEdge === null ? "" : ` · edge ${short(rel.path.directEdge)}`}`}`
    );
  }
  lines.push("", "History");
  const ev = c.evolution;
  if (ev === undefined || ev.strongMemberCouplings.length === 0) {
    lines.push("  none");
  }
  const member = (file: string, pkg: string) =>
    `${short(pkg)}:${file.split("/").pop() ?? file}`;
  for (const k of ev?.strongMemberCouplings ?? []) {
    lines.push(
      `  ${member(k.left, k.leftPackage)} ↔ ${member(k.right, k.rightPackage)} · ${count(k.coChangeCommits)} commits · module path ${k.staticPath} · package path ${k.dependencyPath.forward ?? "—"}/${k.dependencyPath.reverse ?? "—"}`
    );
  }
  if (
    ev !== undefined &&
    (ev.hotspotModules.length > 0 || ev.contextualCouplings > 0)
  ) {
    lines.push(
      `  ${count(ev.contextualCouplings)} contextual couplings · hotspots ${ev.hotspotModules.length === 0 ? "none" : ev.hotspotModules.join(", ")}`
    );
  }
  if (c.recentering !== undefined) {
    lines.push("", "Re-centering");
    const f = c.recentering.finding;
    lines.push(
      `  status ${c.recentering.status}${f === undefined ? "" : ` · ${f.signal} · mismatch ${f.mismatch.toFixed(2)} · confidence ${f.evidenceConfidence.toFixed(2)} · observed ${f.observedCenters.map((o) => `${short(o.target)} ${o.gravity.toFixed(2)}`).join(", ")}`}`
    );
    for (const sc of c.recentering.scenarios) {
      lines.push(
        `  ${sc.kind.padEnd(34)} → ${short(sc.proposedCenter)} · ${sc.status} · ${sc.confidence}${sc.impact === undefined ? "" : ` · impact ${sc.impact.status}${sc.impact.uncertainties.length > 0 ? ` (${sc.impact.uncertainties.join(", ")})` : ""}`}`
      );
    }
    if (c.recentering.review !== undefined) {
      lines.push(...reviewLines(c.recentering.review));
    }
  }
  lines.push("", "Patterns");
  if (c.patterns.length === 0) {
    lines.push("  none");
  }
  for (const id of c.patterns) {
    lines.push(`  ${id}`);
  }
  lines.push(...cautionLines(c.cautions));
  if (c.evidenceRefs !== undefined) {
    lines.push(...evidenceLines(c.evidenceRefs));
  }
  return lines.join("\n");
}

function reviewLines(r: WorkspaceReviewProjection): string[] {
  const lines = [
    `  review ${r.disposition}${r.baselineDominated ? ` · baseline dominated by ${r.dominatingKinds.join(", ")}` : ""}${r.gravityCenter === null ? "" : ` · gravity center ${short(r.gravityCenter)}`}`,
  ];
  if (r.viableScenarios.length > 0) {
    lines.push(`    viable ${r.viableScenarios.join(", ")}`);
  }
  for (const d of r.dominatedScenarios) {
    lines.push(`    ${d.scenarioId} dominated by ${d.dominatedBy}`);
  }
  for (const u of r.unresolved) {
    lines.push(`    unresolved ${u.kind} · ${u.scenarioIds.join(", ")}`);
  }
  return lines;
}

export function renderConceptSummary(
  s: WorkspaceConceptSummaryProjection
): string {
  const lines = title(`${s.concept.name} · ${s.concept.id}`);
  const centers = s.centers;
  lines.push(
    `  ${s.coverage} · ${s.shapes.join(", ") || "no shape"} · ${s.localityShape ?? "—"} · ownership ${s.ownershipAlignment ?? "—"}`
  );
  if (centers !== undefined) {
    lines.push(
      `  semantic ${centers.semantic === undefined ? "—" : short(centers.semantic)} · usage ${centers.usage === undefined ? "—" : short(centers.usage)} · behavior ${centers.behavior === undefined ? "—" : short(centers.behavior)} · implementations ${centers.implementations.map(short).join(", ") || "none"}`
    );
  }
  lines.push(
    `  ${count(s.packages)} packages · ${count(s.boundaries)} boundaries · ${count(s.patterns)} patterns${s.reviewDisposition === undefined ? "" : ` · review ${s.reviewDisposition}`}`
  );
  if (s.cautions.length > 0) {
    lines.push(`  cautions ${s.cautions.join(", ")}`);
  }
  return lines.join("\n");
}

export function renderBoundary(b: WorkspaceBoundaryProjection): string {
  const lines = title(b.boundaryId);
  lines.push(
    `  layers ${b.layers.from ?? "—"} → ${b.layers.to ?? "—"}${b.verified ? " · verified" : ""}${b.structure.seam ? " · seam" : ""}`
  );
  lines.push(`  ${coverageLine(b.coverage)}`);
  lines.push("", "Volume");
  const v = b.volume;
  lines.push(
    `  ${count(v.moduleEdges)} module edges · ${count(v.importSites)} import sites · ${v.references === null ? "references unknown" : `${count(v.references)} references`} · ${count(v.distinctSymbols)} symbols${v.packagePublicSymbols === null ? "" : ` of ${count(v.packagePublicSymbols)} package-public (${percent(v.surfaceCoverage)})`}`
  );
  lines.push(
    `  type-only ${count(v.usage.typeOnlySymbols)} · value-only ${count(v.usage.valueOnlySymbols)} · both ${count(v.usage.bothSymbols)} · ${count(v.breadth.sourceModules)} source modules → ${count(v.breadth.destinationModules)} destination modules`
  );
  lines.push("", "Structure");
  const st = b.structure;
  lines.push(
    st.inPackageGraph
      ? `  severs ${count(st.severedPairs ?? 0)} · alternatives ${count(st.alternativeRoutes ?? 0)}${st.weakBridge ? " · weak bridge" : ""} · betweenness ${(st.betweenness ?? 0).toFixed(3)}`
      : "  not a package-graph edge"
  );
  lines.push("", "Concepts");
  const c = b.concepts;
  lines.push(
    `  ${count(c.total)} concepts · use ${count(c.semanticUse)} · behavior ${count(c.behavior)} · implementation ${count(c.implementation)} · representation ${count(c.representation)} · conversion ${count(c.conversion)}`
  );
  const r = b.ratios.conceptsPerImportSite;
  lines.push(
    `  ${count(r.concepts)} concepts / ${count(r.importSites)} import sites${r.value === null ? "" : ` = ${r.value.toFixed(2)}`}`
  );
  lines.push("", "Patterns");
  lines.push(
    b.patterns.kinds.length === 0
      ? "  none"
      : `  ${b.patterns.kinds.join(", ")} · ${b.patterns.strength ?? ""} · ${b.patterns.coverage ?? ""} coverage · ${b.patterns.patternId ?? ""}`
  );
  if (b.evolution !== undefined) {
    lines.push("", "History");
    lines.push(
      `  ${b.evolution.kinds.join(", ")} · ${count(b.evolution.couplings.length)} ${plural(b.evolution.couplings.length, "coupling")} · ${count(b.evolution.coChangeCommits)} commits · ${count(b.evolution.concepts.length)} concepts · ${b.evolution.patternId}`
    );
  }
  lines.push(...cautionLines(b.cautions));
  if (b.evidenceRefs !== undefined) {
    lines.push(...evidenceLines(b.evidenceRefs));
  }
  return lines.join("\n");
}

export function renderPattern(p: WorkspacePatternProjection): string {
  const lines = title(p.id);
  lines.push(`  ${p.insight.headline}`);
  lines.push(
    `  ${p.family} · ${p.kinds.join(", ")} · ${p.strength} · ${p.coverage} coverage`
  );
  for (const d of p.insight.detail ?? []) {
    lines.push(`  ${d}`);
  }
  lines.push("", "Support");
  lines.push(`  packages ${p.packages.map(short).join(", ") || "none"}`);
  lines.push(
    `  ${count(p.conceptCount)} ${plural(p.conceptCount, "concept")}${p.concepts.length > 0 ? `: ${p.concepts.map((c) => c.split("#").pop() ?? c).join(", ")}` : ""}`
  );
  if (p.boundaries.length > 0) {
    lines.push(`  boundaries ${p.boundaries.map(short).join(", ")}`);
  }
  lines.push("", "Structure");
  for (const [key, value] of Object.entries(p.structure)) {
    lines.push(
      `  ${key.padEnd(20)} ${Array.isArray(value) ? value.map(short).join(", ") || "none" : String(value)}`
    );
  }
  if (p.reviews !== undefined) {
    lines.push("", "Review context", `  ${reviewContextLine(p.reviews)}`);
  }
  lines.push(...cautionLines(p.cautions));
  if (p.evidenceRefs !== undefined) {
    lines.push(...evidenceLines(p.evidenceRefs));
  }
  return lines.join("\n");
}

export function renderGraph(g: WorkspaceGraphProjection): string {
  const lines = title(`GRAPH · ${g.metadata.preset}`);
  lines.push(`  edges: ${g.metadata.edgeSource}`);
  lines.push(`  ${coverageLine(g.metadata.coverage)}`);
  lines.push("", `Nodes (${count(g.nodes.length)})`);
  for (const n of g.nodes) {
    lines.push(
      `  ${n.label.padEnd(18)} ${n.layer === null ? "—" : `L${n.layer}`} · ${n.graphRole ?? "—"} · fan ${count(n.metrics.fanIn)}/${count(n.metrics.fanOut)} · ${count(n.metrics.declaredConcepts)} declared · ${count(n.metrics.participatingConcepts)} participating${n.roles.length > 0 ? ` · ${n.roles.join(", ")}` : ""}${n.cautions.length > 0 ? ` · ${n.cautions.join(", ")}` : ""}`
    );
  }
  lines.push("", `Edges (${count(g.edges.length)})`);
  for (const e of g.edges) {
    const label = `${short(e.from)} → ${short(e.to)}`.padEnd(30);
    switch (e.kind) {
      case "dependency":
        lines.push(
          `  ${label} dependency · ${e.dependency.importSites === null ? `${count(e.dependency.moduleEdges)} module edges` : `${count(e.dependency.importSites)} import sites`} · ${count(e.concepts.total)} concepts (b ${count(e.concepts.behavior)} · i ${count(e.concepts.implementation)} · r ${count(e.concepts.representation)} · u ${count(e.concepts.semanticUse)}) · severs ${count(e.structure.severedPairs)}${e.structure.seam ? " · seam" : ""}${e.patterns.length > 0 ? ` · ${e.patterns.join(", ")}` : ""}`
        );
        break;
      case "direction":
        lines.push(
          `  ${label} ${e.role} · ${count(e.concepts.count)} concepts · static ${e.staticDependencyDirection}${e.pairPatterns.length > 0 ? ` · ${e.pairPatterns.join(", ")}` : ""}`
        );
        break;
      case "review":
        lines.push(`  ${label} review · ${reviewContextLine(e.reviews)}`);
        break;
    }
  }
  if (g.groups.length > 0) {
    lines.push("", "Groups");
    for (const group of g.groups) {
      lines.push(
        `  ${group.id.padEnd(24)} ${group.members.map(short).join(", ")}`
      );
    }
  }
  return lines.join("\n");
}

export function renderConceptGraph(g: WorkspaceConceptGraphProjection): string {
  const lines = title(`CONCEPT GRAPH · ${g.concept}`);
  lines.push("Nodes");
  for (const n of g.nodes) {
    lines.push(
      `  ${n.kind.padEnd(8)} ${n.label.padEnd(28)}${n.focus ? " focus" : ""}${n.package === undefined ? "" : ` · ${short(n.package)}`}${n.layer === undefined || n.layer === null ? "" : ` · L${n.layer}`}`
    );
  }
  lines.push("", "Edges");
  for (const e of g.edges) {
    const from = e.from.split("#").pop() ?? e.from;
    const to = e.to.split("#").pop() ?? e.to;
    lines.push(
      `  ${short(from)} → ${short(to)} · ${e.kind}${e.shapes === undefined ? "" : ` · ${e.shapes.join(", ")}`}${e.conversion === true ? " · conversion" : ""}${e.importSites === undefined ? "" : ` · ${e.importSites === null ? `${count(e.moduleEdges ?? 0)} module edges` : `${count(e.importSites)} import sites`}`}`
    );
  }
  return lines.join("\n");
}

export function renderMatrix(m: WorkspaceMatrixProjection): string {
  const lines = title(`MATRIX · ${m.id}`);
  lines.push(`  ${m.metricLabel}`);
  lines.push(`  ${coverageLine(m.coverage)}`);
  lines.push("");
  const width = Math.max(12, ...m.rows.map((r) => r.label.length)) + 2;
  const colWidth = Math.max(6, ...m.columns.map((c) => c.label.length)) + 1;
  lines.push(
    `${"".padEnd(width)}${m.columns.map((c) => c.label.padStart(colWidth)).join("")}`
  );
  const cells = new Map(m.cells.map((c) => [`${c.row}|${c.column}`, c.value]));
  for (const row of m.rows) {
    lines.push(
      `${row.label.padEnd(width)}${m.columns
        .map((c) => {
          const v = cells.get(`${row.id}|${c.id}`);
          return (
            v === undefined
              ? "·"
              : Number.isInteger(v)
                ? count(v)
                : v.toFixed(2)
          ).padStart(colWidth);
        })
        .join("")}`
    );
  }
  return lines.join("\n");
}

export function renderRank(r: WorkspaceRankProjection): string {
  const lines = title(`RANK · ${r.query.kind} by ${r.query.metric}`);
  lines.push(
    `  ${r.sort} · ${count(r.total)} entries${r.query.limit === undefined ? "" : ` · showing ${count(r.entries.length)}`}`
  );
  lines.push(`  ${coverageLine(r.coverage)}`);
  lines.push("");
  for (const e of r.entries) {
    const value =
      e.numerator === undefined || e.denominator === undefined
        ? Number.isInteger(e.value)
          ? count(e.value)
          : e.value.toFixed(2)
        : `${e.value.toFixed(2)} (${count(e.numerator)} / ${count(e.denominator)})`;
    lines.push(`  ${e.label.padEnd(44)} ${value}`);
  }
  return lines.join("\n");
}

export function renderDirections(d: WorkspaceDirectionListProjection): string {
  const lines = title("DIRECTIONS");
  lines.push(
    `  ${
      Object.entries(d.filter)
        .map(([k, v]) => `${k} ${String(v)}`)
        .join(" · ") || "no filter"
    } · ${d.sort}`
  );
  lines.push("");
  if (d.directions.length === 0) {
    lines.push("  none");
  }
  for (const x of d.directions) {
    lines.push(directionLine(x));
    lines.push(
      `    ${x.concepts.map((c) => c.split("#").pop() ?? c).join(", ")}`
    );
  }
  return lines.join("\n");
}

export function renderReviews(r: WorkspaceReviewListProjection): string {
  const lines = title("REVIEWS");
  lines.push(
    `  ${
      Object.entries(r.filter)
        .map(([k, v]) => `${k} ${String(v)}`)
        .join(" · ") || "no filter"
    } · ${r.sort}`
  );
  lines.push("");
  if (r.reviews.length === 0) {
    lines.push("  none");
  }
  for (const review of r.reviews) {
    lines.push(
      `  ${review.conceptId} · declared ${short(review.declaredPackage)}`
    );
    lines.push(...reviewLines(review));
  }
  return lines.join("\n");
}

export function renderSearch(s: WorkspaceSearchProjection): string {
  const lines = title(`SEARCH · ${s.text}`);
  lines.push(
    `  ${s.mode}${s.kinds === null ? "" : ` · ${s.kinds.join(", ")}`} · ${count(s.matches.length)} matches`
  );
  lines.push("");
  if (s.matches.length === 0) {
    lines.push("  none");
  }
  for (const m of s.matches) {
    lines.push(
      `  ${m.kind.padEnd(9)} ${m.id}${m.package === undefined ? "" : ` · ${short(m.package)}`}`
    );
  }
  return lines.join("\n");
}

export function renderProjectionResult(result: WorkspaceQueryResult): string {
  switch (result.kind) {
    case "overview":
      return renderOverview(result.result);
    case "package":
      return renderPackage(result.result);
    case "package-summary":
      return renderPackageSummary(result.result);
    case "concept":
      return renderConcept(result.result);
    case "concept-summary":
      return renderConceptSummary(result.result);
    case "boundary":
      return renderBoundary(result.result);
    case "pattern":
      return renderPattern(result.result);
    case "review":
      return reviewLines(result.result).join("\n");
    case "graph":
      return renderGraph(result.result);
    case "concept-graph":
      return renderConceptGraph(result.result);
    case "matrix":
      return renderMatrix(result.result);
    case "rank":
      return renderRank(result.result);
    case "directions":
      return renderDirections(result.result);
    case "reviews":
      return renderReviews(result.result);
    case "search":
      return renderSearch(result.result);
    case "ambiguous": {
      const q = result.query;
      const text = "id" in q ? q.id : "conceptId" in q ? q.conceptId : q.kind;
      return [
        `ambiguous name ${text}; use an id:`,
        ...result.candidates.map((c) => `  ${c.id}`),
      ].join("\n");
    }
    case "not-found": {
      const q = result.query;
      const text =
        "id" in q ? q.id : "conceptId" in q ? q.conceptId : JSON.stringify(q);
      return `no ${q.kind} ${text}`;
    }
  }
}
