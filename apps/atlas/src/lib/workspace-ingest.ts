import { createHash } from "node:crypto";

import type {
  ChurnHistoryInfo,
  ConceptIdentity,
  ConceptOverlapCandidate,
  ConceptPropertyOverlap,
  FileChangeCouplingPair,
  PackageChangeCoupling,
  StaticRelation,
  SurfaceReport,
} from "./types";
import type {
  WorkspaceArchitecturalReview,
  WorkspaceBoundary,
  WorkspaceBoundaryPerspective,
  WorkspaceConcept,
  WorkspaceConceptOverlap,
  WorkspaceConflict,
  WorkspaceConflictResolution,
  WorkspaceCouplingPair,
  WorkspaceDependencyEdge,
  WorkspaceDiagnostic,
  WorkspaceDiagnosticKind,
  WorkspaceEntityKind,
  WorkspaceFileChurn,
  WorkspaceHotspot,
  WorkspaceIngestOptions,
  WorkspaceModuleEdge,
  WorkspaceModuleNode,
  WorkspaceObservationDensity,
  WorkspacePackage,
  WorkspacePackageArchitecture,
  WorkspacePackageCoupling,
  WorkspacePackageRadius,
  WorkspaceProvenance,
  WorkspaceRecenteringFinding,
  WorkspaceRecenteringScenario,
  WorkspaceReport,
  WorkspaceReportSource,
  WorkspaceScenarioImpact,
} from "./workspace-types";

import {
  SUPPORTED_PACKAGE_SCHEMAS,
  WORKSPACE_SCHEMA_VERSION,
} from "./workspace-types";

// V9.0 workspace ingestion. Package reports are observations; this file
// turns many of them into one canonical model without re-analysis. Every
// fact is keyed by an id the package reports already carry, a second
// observation of the same id is cross-checked rather than summed, and a
// disagreement becomes a recorded conflict, never a silent choice.
//
// Pipeline: LOAD → VALIDATE → NORMALIZE → IDENTIFY → MERGE → CROSS-CHECK
// → INDEX. Sources are processed in canonical package order and every
// collection is sorted before output, so input order cannot leak into the
// result.

// ---------------------------------------------------------------------------
// LOAD + VALIDATE

export type WorkspaceValidation =
  | { ok: true; report: SurfaceReport }
  | { ok: false; kind: WorkspaceDiagnosticKind; detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const REQUIRED_SECTIONS = [
  "summary",
  "dependencies",
  "dependencyGravity",
  "architecturalProfile",
  "boundaryInteractions",
  "structuralPressure",
  "churn",
  "hotspots",
  "changeCoupling",
  "changeRadius",
  "evolutionaryPressure",
  "conceptInventory",
  "conceptOverlap",
  "conceptOwnership",
  "conceptBehavioralLocality",
  "recenteringCandidates",
] as const;

/**
 * Accepts a bare `SurfaceReport` or the `{ seconds, report }` envelope the
 * tuning sweep writes. Anything else is rejected with a reason; nothing is
 * reinterpreted.
 */
export function validateWorkspaceInput(
  value: unknown,
  supportedSchemas: readonly number[] = SUPPORTED_PACKAGE_SCHEMAS
): WorkspaceValidation {
  if (!isRecord(value)) {
    return {
      detail: "input is not an object",
      kind: "invalid-shape",
      ok: false,
    };
  }
  const candidate =
    "report" in value && isRecord(value.report) && !("schemaVersion" in value)
      ? value.report
      : value;
  const schema = candidate.schemaVersion;
  if (typeof schema !== "number") {
    return {
      detail: "schemaVersion is missing or not a number",
      kind: "invalid-shape",
      ok: false,
    };
  }
  if (!supportedSchemas.includes(schema)) {
    return {
      detail: `schema ${schema} is not supported (accepted: ${supportedSchemas.join(", ")})`,
      kind: "unsupported-schema",
      ok: false,
    };
  }
  const target = candidate.target;
  if (!isRecord(target) || typeof target.path !== "string") {
    return {
      detail: "target.path is missing",
      kind: "missing-target",
      ok: false,
    };
  }
  for (const section of REQUIRED_SECTIONS) {
    if (!isRecord(candidate[section])) {
      return {
        detail: `section ${section} is missing`,
        kind: "invalid-shape",
        ok: false,
      };
    }
  }
  return { ok: true, report: candidate as unknown as SurfaceReport };
}

// ---------------------------------------------------------------------------
// IDENTIFY

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sorted<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort(compare);
}

function hash(facts: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(facts))
    .digest("hex")
    .slice(0, 16);
}

export function packageIdOf(report: SurfaceReport): string {
  return report.target.name ?? report.target.path;
}

function policyVersionOf(report: SurfaceReport): number | undefined {
  const value: unknown = (report as { policyVersion?: unknown }).policyVersion;
  return typeof value === "number" ? value : undefined;
}

function historyOf(
  report: SurfaceReport
): WorkspaceReportSource["history"] | undefined {
  if (!report.churn.available) {
    return undefined;
  }
  const history: ChurnHistoryInfo = report.churn.history;
  return {
    windowDays: history.windowDays,
    ...(history.since !== undefined && { since: history.since }),
    analyzedAt: history.analyzedAt,
    commitsAnalyzed: history.commitsAnalyzed,
  };
}

/** Same window → same id, whichever report measured it. */
function windowIdOf(history: WorkspaceReportSource["history"]): string {
  return history === undefined
    ? "no-history"
    : hash([history.windowDays, history.since ?? null, history.analyzedAt]);
}

export function reportFingerprint(report: SurfaceReport): string {
  return hash({
    boundaries: report.boundaryInteractions.summary,
    families: report.conceptInventory.summary,
    history: historyOf(report) ?? null,
    policyVersion: policyVersionOf(report) ?? null,
    schemaVersion: report.schemaVersion,
    summary: report.summary,
    target: report.target,
  });
}

function sourceOf(report: SurfaceReport): WorkspaceReportSource {
  const policyVersion = policyVersionOf(report);
  const history = historyOf(report);
  return {
    package: packageIdOf(report),
    schemaVersion: report.schemaVersion,
    target: report.target.path,
    ...(policyVersion !== undefined && { policyVersion }),
    reportId: reportFingerprint(report),
    ...(history !== undefined && { history }),
    anchored: report.anchor !== undefined,
    provenance: { source: "analysis-report" },
  };
}

// ---------------------------------------------------------------------------
// MERGE

interface Observed<T> {
  observedBy: Set<string>;
  value: T;
}

class Ledger {
  readonly conflicts: WorkspaceConflict[] = [];
  readonly diagnostics: WorkspaceDiagnostic[] = [];
  readonly naive = new Map<WorkspaceEntityKind, number>();

  count(entity: WorkspaceEntityKind): void {
    this.naive.set(entity, (this.naive.get(entity) ?? 0) + 1);
  }

  conflict(
    entity: WorkspaceEntityKind,
    entityId: string,
    field: string,
    observations: { sourcePackage: string; value: unknown }[],
    resolution: WorkspaceConflictResolution
  ): void {
    this.conflicts.push({ entity, entityId, field, observations, resolution });
  }

  diagnostic(
    kind: WorkspaceDiagnosticKind,
    detail: string,
    source?: string
  ): void {
    this.diagnostics.push({
      kind,
      ...(source !== undefined && { source }),
      detail,
    });
  }
}

class Table<T> {
  readonly entries = new Map<string, Observed<T>>();

  constructor(
    readonly entity: WorkspaceEntityKind,
    readonly ledger: Ledger
  ) {}

  /** Records an observation; `reconcile` runs only for a second observation of the same id. */
  observe(
    id: string,
    source: string,
    value: T,
    reconcile?: (existing: T, incoming: T, sources: [string, string]) => T
  ): Observed<T> {
    this.ledger.count(this.entity);
    const existing = this.entries.get(id);
    if (existing === undefined) {
      const entry = { observedBy: new Set([source]), value };
      this.entries.set(id, entry);
      return entry;
    }
    if (reconcile !== undefined) {
      const previous = [...existing.observedBy].sort(compare)[0] ?? source;
      existing.value = reconcile(existing.value, value, [previous, source]);
    }
    existing.observedBy.add(source);
    return existing;
  }

  get(id: string): Observed<T> | undefined {
    return this.entries.get(id);
  }

  sortedValues(): { id: string; entry: Observed<T> }[] {
    return [...this.entries.entries()]
      .sort(([a], [b]) => compare(a, b))
      .map(([id, entry]) => ({ entry, id }));
  }
}

function provenanceOf(entry: Observed<unknown>): WorkspaceProvenance {
  return { observedBy: sorted(entry.observedBy) };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Cross-checks one field of a twice-observed fact. Equal values verify it;
 * differing values become a conflict with the given resolution and the
 * existing value stands (sources are visited in canonical order, so "first"
 * is deterministic, and authority-bearing callers pass the preferred value).
 */
function crossCheck(
  ledger: Ledger,
  entity: WorkspaceEntityKind,
  id: string,
  field: string,
  observations: { sourcePackage: string; value: unknown }[],
  resolution: WorkspaceConflictResolution
): boolean {
  const [first, ...rest] = observations;
  if (first === undefined || rest.every((o) => same(o.value, first.value))) {
    return true;
  }
  ledger.conflict(entity, id, field, observations, resolution);
  return false;
}

// ---------------------------------------------------------------------------
// Orientation flips for symmetric pairs

function flipRelation(relation: StaticRelation): StaticRelation {
  if (relation === "left-to-right") {
    return "right-to-left";
  }
  if (relation === "right-to-left") {
    return "left-to-right";
  }
  return relation;
}

function orientPair<T extends PackageChangeCoupling>(
  pair: T
): { reversed: boolean; pair: T } {
  if (compare(pair.left, pair.right) <= 0) {
    return { pair, reversed: false };
  }
  return {
    pair: {
      ...pair,
      left: pair.right,
      leftCommits: pair.rightCommits,
      leftConditional: pair.rightConditional,
      right: pair.left,
      rightCommits: pair.leftCommits,
      rightConditional: pair.leftConditional,
      staticRelation: flipRelation(pair.staticRelation),
    },
    reversed: true,
  };
}

/** Property lists are sets whose order follows the observing target; sort them so two perspectives compare equal. */
function normalizeStructure(
  structure: ConceptPropertyOverlap,
  reversed: boolean
): ConceptPropertyOverlap {
  return {
    baseShared: sorted(structure.baseShared),
    compatibleShared: sorted(structure.compatibleShared),
    jaccard: structure.jaccard,
    leftOnly: sorted(reversed ? structure.rightOnly : structure.leftOnly),
    rightOnly: sorted(reversed ? structure.leftOnly : structure.rightOnly),
    shared: sorted(structure.shared),
    sharedOverLeft: reversed
      ? structure.sharedOverRight
      : structure.sharedOverLeft,
    sharedOverRight: reversed
      ? structure.sharedOverLeft
      : structure.sharedOverRight,
  };
}

function orientOverlap(candidate: ConceptOverlapCandidate): {
  id: string;
  value: Omit<WorkspaceConceptOverlap, "verified" | "provenance">;
} {
  const reversed = compare(candidate.left.id, candidate.right.id) > 0;
  const left = reversed ? candidate.right : candidate.left;
  const right = reversed ? candidate.left : candidate.right;
  const assignability =
    candidate.assignability === undefined
      ? undefined
      : reversed
        ? candidate.assignability === "left-to-right"
          ? "right-to-left"
          : candidate.assignability === "right-to-left"
            ? "left-to-right"
            : candidate.assignability
        : candidate.assignability;
  const structure =
    candidate.structure === undefined
      ? undefined
      : normalizeStructure(candidate.structure, reversed);
  const id = `${left.id}|${right.id}`;
  return {
    id,
    value: {
      crossPackage: candidate.crossPackage,
      dimensions: candidate.dimensions,
      id,
      left: { ...left, inTarget: false },
      right: { ...right, inTarget: false },
      shapes: candidate.shapes,
      ...(candidate.name !== undefined && { name: candidate.name }),
      ...(structure !== undefined && { structure }),
      ...(assignability !== undefined && { assignability }),
      bidirectionalConversion: candidate.bidirectionalConversion,
      conversions: [...candidate.conversions].sort(
        (a, b) =>
          compare(a.from, b.from) ||
          compare(a.to, b.to) ||
          compare(a.file, b.file) ||
          compare(a.function, b.function)
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Ingestion state

interface Tables {
  architecture: Table<Omit<WorkspacePackageArchitecture, "provenance">>;
  boundaries: Table<Omit<WorkspaceBoundary, "provenance">>;
  churn: Table<Omit<WorkspaceFileChurn, "provenance">>;
  concepts: Table<Omit<WorkspaceConcept, "provenance" | "overlaps">>;
  couplings: Table<Omit<WorkspaceCouplingPair, "provenance">>;
  dependencyEdges: Table<
    Omit<WorkspaceDependencyEdge, "provenance" | "verified"> & {
      verified: boolean;
    }
  >;
  findings: Table<Omit<WorkspaceRecenteringFinding, "provenance">>;
  hotspots: Table<Omit<WorkspaceHotspot, "provenance">>;
  impacts: Table<Omit<WorkspaceScenarioImpact, "provenance">>;
  moduleEdges: Table<Omit<WorkspaceModuleEdge, "provenance">>;
  modules: Table<Omit<WorkspaceModuleNode, "provenance">>;
  overlaps: Table<Omit<WorkspaceConceptOverlap, "provenance">>;
  packageCouplings: Table<Omit<WorkspacePackageCoupling, "provenance">>;
  packages: Table<Omit<WorkspacePackage, "provenance">>;
  radius: Table<Omit<WorkspacePackageRadius, "provenance">>;
  reviews: Table<Omit<WorkspaceArchitecturalReview, "provenance">>;
  scenarios: Table<Omit<WorkspaceRecenteringScenario, "provenance">>;
}

function tables(ledger: Ledger): Tables {
  return {
    architecture: new Table("package", ledger),
    boundaries: new Table("boundary", ledger),
    churn: new Table("churn", ledger),
    concepts: new Table("concept", ledger),
    couplings: new Table("coupling", ledger),
    dependencyEdges: new Table("dependencyEdge", ledger),
    findings: new Table("finding", ledger),
    hotspots: new Table("hotspot", ledger),
    impacts: new Table("impact", ledger),
    moduleEdges: new Table("moduleEdge", ledger),
    modules: new Table("module", ledger),
    overlaps: new Table("overlap", ledger),
    packageCouplings: new Table("packageCoupling", ledger),
    packages: new Table("package", ledger),
    radius: new Table("package", ledger),
    reviews: new Table("review", ledger),
    scenarios: new Table("scenario", ledger),
  };
}

function edgeId(from: string, to: string): string {
  return `${from}→${to}`;
}

// ---------------------------------------------------------------------------
// Per-report merge steps

/** A package mentioned by name but not (yet) analyzed: identity only. */
function mentionPackage(t: Tables, source: string, name: string): void {
  t.packages.observe(name, source, {
    analyzed: false,
    anchored: false,
    id: name,
    name,
  });
}

function mergePackage(t: Tables, report: SurfaceReport): string {
  const id = packageIdOf(report);
  const own: Omit<WorkspacePackage, "provenance"> = {
    analyzed: true,
    anchored: report.anchor !== undefined,
    id,
    name: id,
    path: report.target.path,
    ...(report.anchor?.reason !== undefined && {
      anchorReason: report.anchor.reason,
    }),
    gravity: report.architecturalProfile.target.gravity,
    surface: {
      consumerPackages: report.dependencies.consumerPackages,
      dependencyPackages: report.dependencies.dependencyPackages,
      exportUtilization: report.summary.exportUtilization,
      externallyUsedSymbols: report.summary.externallyUsedSymbols,
      packagePublicSymbols: report.summary.packagePublicSymbols,
      shapeSignals: report.dependencies.shapeSignals,
      totalSymbols: report.summary.totalSymbols,
      unusedExternalExports: report.summary.unusedExternalExports,
    },
  };
  // The package's own report is authoritative over a mention from elsewhere.
  t.packages.observe(id, id, own, (existing, incoming) =>
    incoming.analyzed ? incoming : existing
  );
  return id;
}

function mergeGraph(t: Tables, report: SurfaceReport, self: string): void {
  const ledger = t.modules.ledger;
  for (const module of report.dependencyGravity.modules) {
    const value: Omit<WorkspaceModuleNode, "provenance"> = {
      id: module.node.id,
      package: self,
      ...(module.role !== undefined && { role: module.role }),
      ...(module.fileKind !== undefined && { fileKind: module.fileKind }),
      gravity: {
        fanIn: module.direct.fanIn,
        fanOut: module.direct.fanOut,
        transitiveDependencies: module.transitive.dependencies,
        transitiveDependents: module.transitive.dependents,
      },
    };
    t.modules.observe(module.node.id, self, value, (existing, incoming, by) => {
      if (incoming.role === undefined) {
        return existing;
      }
      if (existing.role === undefined) {
        return { ...existing, ...incoming };
      }
      crossCheck(
        ledger,
        "module",
        module.node.id,
        "role",
        [
          { sourcePackage: by[0], value: existing.role },
          { sourcePackage: by[1], value: incoming.role },
        ],
        "unresolved"
      );
      return existing;
    });
  }
  const observeEdges = (
    from: string,
    to: string,
    edges: { fromFile: string; toFile: string; typeOnly?: boolean }[]
  ): void => {
    const id = edgeId(from, to);
    t.dependencyEdges.observe(
      id,
      self,
      { from, id, moduleEdges: edges.length, to, verified: false },
      (existing, incoming, by) => ({
        ...existing,
        verified: crossCheck(
          ledger,
          "dependencyEdge",
          id,
          "moduleEdges",
          [
            { sourcePackage: by[0], value: existing.moduleEdges },
            { sourcePackage: by[1], value: incoming.moduleEdges },
          ],
          "unresolved"
        ),
      })
    );
    for (const edge of edges) {
      const moduleEdge = edgeId(edge.fromFile, edge.toFile);
      t.moduleEdges.observe(moduleEdge, self, {
        from: edge.fromFile,
        fromPackage: from,
        id: moduleEdge,
        to: edge.toFile,
        toPackage: to,
        ...(edge.typeOnly !== undefined && { typeOnly: edge.typeOnly }),
      });
      t.modules.observe(edge.fromFile, self, {
        id: edge.fromFile,
        package: from,
      });
      t.modules.observe(edge.toFile, self, { id: edge.toFile, package: to });
    }
  };
  for (const consumer of report.dependencies.incoming) {
    mentionPackage(t, self, consumer.package);
    observeEdges(consumer.package, self, consumer.moduleEdges);
  }
  for (const dependency of report.dependencies.outgoing) {
    mentionPackage(t, self, dependency.package);
    observeEdges(self, dependency.package, dependency.modules);
  }
}

function perspectiveOf(
  observedBy: string,
  interaction: SurfaceReport["boundaryInteractions"]["incoming"][number]
): WorkspaceBoundaryPerspective {
  return {
    breadth: {
      destinationModules: interaction.breadth.destinationModules,
      sourceModules: interaction.breadth.sourceModules,
    },
    distinctSymbols: interaction.symbols.distinct,
    importSites: interaction.importSites,
    moduleEdges: interaction.moduleEdges,
    observedBy,
    usage: {
      bothSymbols: interaction.usage.bothSymbols,
      namespace: interaction.usage.namespace,
      typeOnlySymbols: interaction.usage.typeOnlySymbols,
      valueOnlySymbols: interaction.usage.valueOnlySymbols,
    },
  };
}

/** Destination-observed values win where present; they measure the destination's own surface. */
function canonicalBoundary(
  id: string,
  from: string,
  to: string,
  perspectives: WorkspaceBoundary["perspectives"],
  destinationFacts:
    | {
        packagePublic: number | null;
        references: number | null;
        surfaceCoverage: number | null;
      }
    | undefined,
  verified: boolean
): Omit<WorkspaceBoundary, "provenance"> {
  const lead = perspectives.destination ?? perspectives.source;
  if (lead === undefined) {
    throw new Error(`boundary ${id} has no perspective`);
  }
  return {
    breadth: lead.breadth,
    from,
    id,
    importSites: lead.importSites,
    moduleEdges: lead.moduleEdges,
    perspectives,
    surfaceCoverage: destinationFacts?.surfaceCoverage ?? null,
    symbols: {
      distinct: lead.distinctSymbols,
      packagePublic: destinationFacts?.packagePublic ?? null,
      references: destinationFacts?.references ?? null,
    },
    to,
    usage: lead.usage,
    verified,
  };
}

function mergeBoundaries(t: Tables, report: SurfaceReport, self: string): void {
  const ledger = t.boundaries.ledger;
  const interactions = [
    ...report.boundaryInteractions.incoming.map((i) => ({
      interaction: i,
      orientation: "destination" as const,
    })),
    ...report.boundaryInteractions.outgoing.map((i) => ({
      interaction: i,
      orientation: "source" as const,
    })),
  ];
  for (const { interaction, orientation } of interactions) {
    const id = edgeId(interaction.from, interaction.to);
    const perspective = perspectiveOf(self, interaction);
    const destinationFacts =
      orientation === "destination"
        ? {
            packagePublic: interaction.symbols.packagePublic,
            references: interaction.symbols.references,
            surfaceCoverage: interaction.surfaceCoverage,
          }
        : undefined;
    const fresh = canonicalBoundary(
      id,
      interaction.from,
      interaction.to,
      { [orientation]: perspective },
      destinationFacts,
      false
    );
    t.boundaries.observe(id, self, fresh, (existing, _incoming, by) => {
      const perspectives = {
        ...existing.perspectives,
        [orientation]: perspective,
      };
      const other =
        orientation === "destination"
          ? existing.perspectives.source
          : existing.perspectives.destination;
      if (other === undefined) {
        // Same orientation twice can only come from overlapping targets.
        crossCheck(
          ledger,
          "boundary",
          id,
          orientation,
          [
            { sourcePackage: by[0], value: existing.perspectives[orientation] },
            { sourcePackage: by[1], value: perspective },
          ],
          "unresolved"
        );
        return existing;
      }
      const pair = (field: keyof WorkspaceBoundaryPerspective) => [
        { sourcePackage: other.observedBy, value: other[field] },
        { sourcePackage: perspective.observedBy, value: perspective[field] },
      ];
      const verified = crossCheck(
        ledger,
        "boundary",
        id,
        "moduleEdges",
        pair("moduleEdges"),
        "unresolved"
      );
      for (const field of [
        "importSites",
        "distinctSymbols",
        "usage",
        "breadth",
      ] as const) {
        crossCheck(ledger, "boundary", id, field, pair(field), "target-scoped");
      }
      const facts =
        orientation === "destination"
          ? destinationFacts
          : {
              packagePublic: existing.symbols.packagePublic,
              references: existing.symbols.references,
              surfaceCoverage: existing.surfaceCoverage,
            };
      return canonicalBoundary(
        id,
        interaction.from,
        interaction.to,
        perspectives,
        facts,
        verified
      );
    });
  }
}

function conceptStub(
  identity: ConceptIdentity,
  source: string,
  role: "seed" | "overlap-partner"
): Omit<WorkspaceConcept, "provenance" | "overlaps"> {
  return {
    analysis: role === "seed" ? "seed-report" : "foreign-only",
    file: identity.file,
    id: identity.id,
    kind: identity.kind,
    name: identity.name,
    observations: [{ role, source }],
    package: identity.package,
  };
}

function mergeConceptObservation(
  existing: Omit<WorkspaceConcept, "provenance" | "overlaps">,
  incoming: Omit<WorkspaceConcept, "provenance" | "overlaps">
): Omit<WorkspaceConcept, "provenance" | "overlaps"> {
  const observations = [...existing.observations, ...incoming.observations];
  // A seed observation carries the target-scoped analyses; a partner
  // observation carries identity only.
  const lead = existing.analysis === "seed-report" ? existing : incoming;
  const { observations: _drop, ...facts } = lead;
  return { ...facts, observations };
}

function mergeConcepts(t: Tables, report: SurfaceReport, self: string): void {
  const ledger = t.concepts.ledger;
  const ownership = new Map(
    report.conceptOwnership.concepts.map((c) => [c.concept.id, c])
  );
  const locality = new Map(
    report.conceptBehavioralLocality.concepts.map((c) => [c.concept.id, c])
  );
  const status = new Map(
    report.recenteringCandidates.candidates.map((c) => [
      c.subject.concept.id,
      c.status,
    ])
  );
  const findings = new Map(
    report.recenteringCandidates.miscentered.findings.map((f) => [
      f.concept.id,
      f.id,
    ])
  );
  for (const family of report.conceptInventory.families) {
    const seed = family.seed;
    const identity: ConceptIdentity = {
      file: seed.declaration.file,
      id: seed.id,
      inTarget: true,
      kind: seed.kind,
      name: seed.name,
      package: seed.declaration.package,
    };
    mentionPackage(t, self, identity.package);
    const value = conceptStub(identity, self, "seed");
    value.relationships = family.relationships;
    const analysis = family.distributionAnalysis;
    if (analysis !== undefined) {
      value.representations = {
        byPackage: [...analysis.representations.packages]
          .map((p) => ({
            package: p.package,
            representations: p.representations,
          }))
          .sort((a, b) => compare(a.package, b.package)),
        total: analysis.representations.total,
      };
      value.distribution = {
        moduleCount: family.distribution.moduleCount,
        packages: sorted(family.distribution.packages),
        references: family.distribution.references,
        ...(analysis.references.primaryPackage !== undefined && {
          primaryPackage: analysis.references.primaryPackage,
        }),
        primaryShare: analysis.references.primaryShare,
        shapes: analysis.shapes,
      };
    }
    const owned = ownership.get(seed.id);
    if (owned !== undefined) {
      value.ownership = {
        alignment: owned.alignment,
        center: owned.center,
        participation: owned.candidates
          .map((candidate) => ({
            conversions: candidate.participation.conversions,
            implementations: candidate.participation.implementations,
            package: candidate.package,
            references: candidate.participation.references,
            representations: candidate.participation.representations,
          }))
          .sort((a, b) => compare(a.package, b.package)),
        tensions: sorted(owned.tensions.map((tension) => tension.kind)),
      };
    }
    const local = locality.get(seed.id);
    if (local !== undefined) {
      value.locality = {
        modifiers: local.shape.modifiers,
        moduleCount: local.span.moduleCount,
        packageBoundaryCount: local.span.packageBoundaryCount,
        packageCount: local.span.packageCount,
        shape: local.shape.primary,
        sourceModuleCount: local.span.sourceModuleCount,
        ...(local.concentration.primaryPackage !== undefined && {
          primaryPackage: local.concentration.primaryPackage,
        }),
        anchored: local.anchored,
        behavior: local.behavior.byPackage
          .map((p) => ({
            contractBehaviors: p.contractBehaviors,
            conversionBehaviors: p.conversionBehaviors,
            implementationBehaviors: p.implementationBehaviors,
            package: p.package,
            sourceBehaviors: p.sourceBehaviors,
            storyBehaviors: p.storyBehaviors,
            testBehaviors: p.testBehaviors,
          }))
          .sort((a, b) => compare(a.package, b.package)),
        primaryPackageShare: local.concentration.primaryPackageShare,
      };
    }
    const temporal = analysis?.temporal;
    const hotspots = local?.temporal?.hotspots;
    if (temporal !== undefined || hotspots !== undefined) {
      value.evolution = {
        couplings: sorted(
          (temporal?.strongMemberCouplings ?? []).map((pair) =>
            [pair.left.file, pair.right.file].sort(compare).join("|")
          )
        ),
        hotspotModules: sorted((hotspots ?? []).map((h) => h.module)),
      };
    }
    const recentering = status.get(seed.id);
    const findingId = findings.get(seed.id);
    if (recentering !== undefined || findingId !== undefined) {
      value.recentering = {
        status: recentering ?? "candidate",
        ...(findingId !== undefined && { findingId }),
      };
    }
    t.concepts.observe(seed.id, self, value, (existing, incoming, by) => {
      if (existing.analysis === "seed-report") {
        // Two seed observations: the declaring package's own report leads.
        const preferred =
          incoming.package === by[1] && existing.package !== by[0]
            ? incoming
            : existing;
        crossCheck(
          ledger,
          "concept",
          seed.id,
          "distribution",
          [
            { sourcePackage: by[0], value: existing.distribution },
            { sourcePackage: by[1], value: incoming.distribution },
          ],
          "preferred-authority"
        );
        return {
          ...preferred,
          observations: [...existing.observations, ...incoming.observations],
        };
      }
      return mergeConceptObservation(existing, incoming);
    });
  }
  for (const candidate of report.conceptOverlap.candidates) {
    for (const side of [candidate.left, candidate.right]) {
      if (side.inTarget) {
        continue;
      }
      mentionPackage(t, self, side.package);
      t.concepts.observe(
        side.id,
        self,
        conceptStub(side, self, "overlap-partner"),
        mergeConceptObservation
      );
    }
    const { id, value } = orientOverlap(candidate);
    t.overlaps.observe(
      id,
      self,
      { ...value, verified: false },
      (existing, incoming, by) => {
        const { verified: _v, ...existingFacts } = existing;
        const { verified: _w, ...incomingFacts } = incoming;
        const verified = crossCheck(
          ledger,
          "overlap",
          id,
          "evidence",
          [
            { sourcePackage: by[0], value: existingFacts },
            { sourcePackage: by[1], value: incomingFacts },
          ],
          "unresolved"
        );
        return { ...existing, verified };
      }
    );
  }
}

function mergeEvolution(
  t: Tables,
  report: SurfaceReport,
  self: string,
  windowId: string,
  packageOf: (file: string) => string | undefined
): void {
  const ledger = t.churn.ledger;
  if (report.churn.available) {
    for (const file of report.churn.files) {
      const owner = packageOf(file.file);
      const observation = {
        additions: file.additions,
        commits: file.commits,
        deletions: file.deletions,
        linesChanged: file.linesChanged,
        source: self,
        window: windowId,
      };
      const value: Omit<WorkspaceFileChurn, "provenance"> = {
        file: file.file,
        ...(owner !== undefined && { package: owner }),
        additions: file.additions,
        commits: file.commits,
        deletions: file.deletions,
        kind: file.kind,
        linesChanged: file.linesChanged,
        ...(file.lastChangedAt !== undefined && {
          lastChangedAt: file.lastChangedAt,
        }),
        authors: file.authors,
        observations: [observation],
      };
      t.churn.observe(file.file, self, value, (existing, incoming, by) => {
        const previous = existing.observations[0];
        const sameWindow = previous?.window === windowId;
        crossCheck(
          ledger,
          "churn",
          file.file,
          "commits",
          [
            {
              sourcePackage: by[0],
              value: { commits: existing.commits, window: previous?.window },
            },
            {
              sourcePackage: by[1],
              value: { commits: incoming.commits, window: windowId },
            },
          ],
          sameWindow ? "unresolved" : "target-scoped"
        );
        // The file's own package report leads; otherwise the first in canonical order.
        const lead =
          incoming.package === by[1] && existing.package !== by[0]
            ? incoming
            : existing;
        return {
          ...lead,
          observations: [...existing.observations, observation],
        };
      });
    }
  }
  if (report.hotspots.available) {
    for (const spot of report.hotspots.files) {
      const owner = packageOf(spot.file);
      t.hotspots.observe(spot.file, self, {
        file: spot.file,
        ...(owner !== undefined && { package: owner }),
        commitPercentile: spot.evolution.commitPercentile,
        commits: spot.evolution.commits,
        complexityPercentile: spot.rank.complexityPercentile,
        kind: spot.kind,
        signals: spot.signals,
      });
    }
  }
  if (report.changeCoupling.available) {
    for (const raw of report.changeCoupling.filePairs) {
      const { reversed, pair } = orientPair<FileChangeCouplingPair>(raw);
      const id = `${pair.left}|${pair.right}`;
      const value: Omit<WorkspaceCouplingPair, "provenance"> = {
        coChangeCommits: pair.coChangeCommits,
        context: pair.context,
        id,
        jaccard: pair.jaccard,
        left: pair.left,
        leftCommits: pair.leftCommits,
        leftConditional: pair.leftConditional,
        leftPackage: reversed ? raw.rightPackage : raw.leftPackage,
        right: pair.right,
        rightCommits: pair.rightCommits,
        rightConditional: pair.rightConditional,
        rightPackage: reversed ? raw.leftPackage : raw.rightPackage,
        scope: pair.scope,
        staticPath: pair.staticPath,
        staticRelation: pair.staticRelation,
        ...(pair.lastCoChangedAt !== undefined && {
          lastCoChangedAt: pair.lastCoChangedAt,
        }),
        verified: false,
      };
      t.couplings.observe(id, self, value, (existing, incoming, by) =>
        reconcilePair("coupling", existing, incoming, by)
      );
    }
    for (const raw of report.changeCoupling.packagePairs) {
      const { pair } = orientPair(raw);
      const id = `${pair.left}|${pair.right}`;
      const value: Omit<WorkspacePackageCoupling, "provenance"> = {
        coChangeCommits: pair.coChangeCommits,
        id,
        jaccard: pair.jaccard,
        left: pair.left,
        leftCommits: pair.leftCommits,
        leftConditional: pair.leftConditional,
        right: pair.right,
        rightCommits: pair.rightCommits,
        rightConditional: pair.rightConditional,
        staticPath: pair.staticPath,
        staticRelation: pair.staticRelation,
        verified: false,
      };
      t.packageCouplings.observe(id, self, value, (existing, incoming, by) =>
        reconcilePair("packageCoupling", existing, incoming, by)
      );
    }
  }
  if (report.changeRadius.available) {
    const summary = report.changeRadius.summary;
    t.radius.observe(self, self, {
      boundariesP50: summary.boundaries.p50,
      boundaryCrossingRate: summary.boundaryCrossingRate,
      commits: summary.commits,
      crossPackageRate: summary.crossPackageRate,
      filesP50: summary.files.p50,
      package: self,
      packagesP50: summary.packages.p50,
    });
  }

  function reconcilePair<T extends { id: string; verified: boolean }>(
    entity: WorkspaceEntityKind,
    existing: T,
    incoming: T,
    by: [string, string]
  ): T {
    const { verified: _v, ...existingFacts } = existing;
    const { verified: _w, ...incomingFacts } = incoming;
    const verified = crossCheck(
      ledger,
      entity,
      existing.id,
      "coupling",
      [
        { sourcePackage: by[0], value: existingFacts },
        { sourcePackage: by[1], value: incomingFacts },
      ],
      "target-scoped"
    );
    return { ...existing, verified };
  }
}

function mergeArchitecture(
  t: Tables,
  report: SurfaceReport,
  self: string
): void {
  const ledger = t.findings.ledger;
  const pressure = report.evolutionaryPressure;
  t.architecture.observe(self, self, {
    anchored: report.anchor !== undefined,
    boundaryPressure: report.structuralPressure.boundaries.map((b) => ({
      from: b.from,
      shape: b.shape,
      to: b.to,
    })),
    package: self,
    profileSignals: report.architecturalProfile.target.signals.map(
      (s) => s.signal
    ),
    structuralPressure: report.structuralPressure.signals.map((s) => s.kind),
    ...(pressure.available && {
      evolutionaryPressure: {
        historicalSupport: pressure.historicalSupport,
        reinforced: pressure.reinforced.map((s) => s.kind),
        tensions: pressure.tensions.map((s) => s.kind),
      },
    }),
  });
  const recentering = report.recenteringCandidates;
  const verify =
    <T>(
      entity: WorkspaceEntityKind,
      id: string
    ): ((existing: T, incoming: T, by: [string, string]) => T) =>
    (existing, incoming, by) => {
      crossCheck(
        ledger,
        entity,
        id,
        "facts",
        [
          { sourcePackage: by[0], value: existing },
          { sourcePackage: by[1], value: incoming },
        ],
        "unresolved"
      );
      return existing;
    };
  for (const finding of recentering.miscentered.findings) {
    t.findings.observe(
      finding.id,
      self,
      {
        anchored: finding.anchored,
        concept: finding.concept,
        declaredHome: finding.declaredHome,
        evidenceConfidence: finding.evidenceConfidence,
        id: finding.id,
        mismatch: finding.mismatch,
        observedCenters: finding.observedCenters.map((c) => ({
          anchored: c.anchored,
          gravity: c.gravity,
          target: c.target,
        })),
        signal: finding.signal,
      },
      verify("finding", finding.id)
    );
  }
  for (const finding of recentering.scenarios.findings) {
    for (const scenario of finding.scenarios) {
      t.scenarios.observe(
        scenario.id,
        self,
        {
          conceptId: scenario.subject.id,
          confidence: scenario.confidence,
          constraints: sorted(scenario.constraints.map((c) => c.kind)),
          findingId: scenario.findingId,
          id: scenario.id,
          kind: scenario.kind,
          proposedCenter: scenario.proposed.semanticCenter,
          resolved: false,
          status: scenario.status,
        },
        verify("scenario", scenario.id)
      );
    }
  }
  for (const finding of recentering.impacts.findings) {
    for (const impact of finding.scenarios) {
      t.impacts.observe(
        impact.scenarioId,
        self,
        {
          certainty: impact.certainty,
          changes: sorted(impact.changes.map((c) => c.kind)),
          findingId: impact.findingId,
          resolved: false,
          scenarioId: impact.scenarioId,
          status: impact.status,
          summary: impact.summary,
          uncertainties: sorted(impact.uncertainties.map((u) => u.kind)),
          unmeasuredEdges: sorted(
            impact.impact.dependency.uncertain
              .filter((edge) => !edge.measured)
              .map((edge) => `${edge.from}→${edge.to}`)
          ),
        },
        verify("impact", impact.scenarioId)
      );
    }
  }
  for (const review of recentering.reviews.reviews) {
    t.reviews.observe(
      review.findingId,
      self,
      {
        baselineScenarioId: review.baselineScenarioId,
        conceptId: review.concept.id,
        disposition: review.disposition,
        dominated: review.dominated,
        findingId: review.findingId,
        invalid: review.invalid,
        resolved: false,
        scenarios: review.scenarios.map((s) => ({
          scenarioId: s.scenarioId,
          status: s.status,
        })),
        unresolved: review.unresolved.map((u) => ({
          kind: u.kind,
          scenarioIds: [...u.scenarioIds],
        })),
        viable: review.viable,
      },
      verify("review", review.findingId)
    );
  }
}

// ---------------------------------------------------------------------------
// INDEX

function densityOf<T>(table: Table<T>): WorkspaceObservationDensity {
  const density = { one: 0, threePlus: 0, two: 0 };
  for (const entry of table.entries.values()) {
    const n = entry.observedBy.size;
    if (n >= 3) {
      density.threePlus += 1;
    } else if (n === 2) {
      density.two += 1;
    } else {
      density.one += 1;
    }
  }
  return density;
}

function materialize<T extends object>(
  table: Table<T>
): (T & { provenance: WorkspaceProvenance })[] {
  return table
    .sortedValues()
    .map(({ entry }) => ({ ...entry.value, provenance: provenanceOf(entry) }));
}

const ENTITY_KINDS: WorkspaceEntityKind[] = [
  "package",
  "module",
  "moduleEdge",
  "dependencyEdge",
  "boundary",
  "concept",
  "overlap",
  "churn",
  "hotspot",
  "coupling",
  "packageCoupling",
  "finding",
  "scenario",
  "impact",
  "review",
];

// ---------------------------------------------------------------------------
// Entry point

/**
 * Turns package reports into one canonical `WorkspaceReport`. Pure: no
 * filesystem, no Git, no TypeScript. Accepts raw JSON values so callers can
 * feed parsed files directly; invalid inputs become diagnostics, not throws.
 */
export function ingestWorkspaceReports(
  inputs: readonly unknown[],
  options: WorkspaceIngestOptions = {}
): WorkspaceReport {
  const supported = options.supportedSchemas ?? SUPPORTED_PACKAGE_SCHEMAS;
  const ledger = new Ledger();

  // LOAD + VALIDATE
  const accepted: SurfaceReport[] = [];
  let rejected = 0;
  for (const input of inputs) {
    const validation = validateWorkspaceInput(input, supported);
    if (validation.ok) {
      accepted.push(validation.report);
    } else {
      rejected += 1;
      ledger.diagnostic(validation.kind, validation.detail);
    }
  }

  // IDENTIFY: one report per target; identical duplicates collapse,
  // differing duplicates make the target ambiguous and are all rejected.
  const byTarget = new Map<string, SurfaceReport[]>();
  for (const report of accepted) {
    const id = packageIdOf(report);
    byTarget.set(id, [...(byTarget.get(id) ?? []), report]);
  }
  let duplicates = 0;
  const reports: SurfaceReport[] = [];
  for (const id of sorted(byTarget.keys())) {
    const group = byTarget.get(id) ?? [];
    const fingerprints = new Set(group.map(reportFingerprint));
    if (fingerprints.size > 1) {
      rejected += group.length;
      ledger.diagnostic(
        "ambiguous-target",
        `${group.length} differing reports for ${id}; all rejected`,
        id
      );
      continue;
    }
    const [first, ...rest] = group;
    if (first === undefined) {
      continue;
    }
    reports.push(first);
    duplicates += rest.length;
    for (const _extra of rest) {
      ledger.diagnostic("duplicate-source", "identical report ignored", id);
    }
  }

  const sources = reports.map(sourceOf);
  const policies = new Set<number>();
  for (const source of sources) {
    if (source.policyVersion === undefined) {
      ledger.diagnostic(
        "unknown-policy",
        `schema ${source.schemaVersion} report carries no policyVersion`,
        source.package
      );
    } else {
      policies.add(source.policyVersion);
    }
  }
  if (policies.size > 1) {
    ledger.diagnostic(
      "mixed-policy",
      `policy versions ${[...policies].sort((a, b) => a - b).join(", ")}; derived facts may not be comparable across sources`
    );
  }

  // NORMALIZE + MERGE + CROSS-CHECK, in canonical source order.
  const t = tables(ledger);
  const paths = reports
    .map((r) => ({ id: packageIdOf(r), path: r.target.path }))
    .sort((a, b) => b.path.length - a.path.length);
  const packageOf = (file: string): string | undefined =>
    paths.find((p) => file === p.path || file.startsWith(`${p.path}/`))?.id;
  for (const report of reports) {
    const self = mergePackage(t, report);
    const windowId = windowIdOf(historyOf(report));
    mergeGraph(t, report, self);
    mergeBoundaries(t, report, self);
    mergeConcepts(t, report, self);
    mergeEvolution(t, report, self, windowId, packageOf);
    mergeArchitecture(t, report, self);
  }

  // Cross-report references.
  const findingIds = new Set(t.findings.entries.keys());
  const scenarioIds = new Set(t.scenarios.entries.keys());
  for (const { id, entry } of t.scenarios.sortedValues()) {
    entry.value.resolved = findingIds.has(entry.value.findingId);
    if (!entry.value.resolved) {
      ledger.diagnostic(
        "broken-reference",
        `scenario ${id} refers to missing finding ${entry.value.findingId}`
      );
    }
  }
  for (const { id, entry } of t.impacts.sortedValues()) {
    entry.value.resolved = scenarioIds.has(id);
    if (!entry.value.resolved) {
      ledger.diagnostic(
        "broken-reference",
        `impact refers to missing scenario ${id}`
      );
    }
  }
  for (const { id, entry } of t.reviews.sortedValues()) {
    const missing = entry.value.scenarios
      .map((s) => s.scenarioId)
      .filter((scenarioId) => !scenarioIds.has(scenarioId));
    entry.value.resolved = findingIds.has(id) && missing.length === 0;
    if (!entry.value.resolved) {
      ledger.diagnostic(
        "broken-reference",
        `review ${id} refers to ${findingIds.has(id) ? `missing scenarios ${missing.join(", ")}` : "a missing finding"}`
      );
    }
  }

  // Coverage.
  const populations = new Set(
    reports.map((r) => r.dependencyGravity.population.packages)
  );
  let population: number | undefined;
  if (populations.size === 1) {
    [population] = populations;
  } else if (populations.size > 1) {
    ledger.diagnostic(
      "population-mismatch",
      `reports disagree on workspace package count: ${[...populations].sort((a, b) => a - b).join(", ")}`
    );
  }
  const analyzed = sorted(sources.map((s) => s.package));
  const known = sorted(t.packages.entries.keys());
  const missing = known.filter((name) => !t.packages.get(name)?.value.analyzed);
  const complete =
    missing.length === 0 &&
    (population === undefined || population === analyzed.length);
  if (!complete) {
    ledger.diagnostic(
      "partial-coverage",
      `${analyzed.length} of ${population ?? known.length} packages analyzed`
    );
  }

  // INDEX
  const overlapsByConcept = new Map<string, string[]>();
  for (const { id, entry } of t.overlaps.sortedValues()) {
    for (const side of [entry.value.left.id, entry.value.right.id]) {
      overlapsByConcept.set(side, [...(overlapsByConcept.get(side) ?? []), id]);
    }
  }
  const concepts: WorkspaceConcept[] = t.concepts
    .sortedValues()
    .map(({ id, entry }) => ({
      ...entry.value,
      // One row per (source, role): a partner named by several overlap
      // candidates of one report is still one observation.
      observations: [
        ...new Map(
          entry.value.observations.map((o) => [`${o.source} ${o.role}`, o])
        ).values(),
      ].sort((a, b) => compare(a.source, b.source) || compare(a.role, b.role)),
      overlaps: sorted(overlapsByConcept.get(id) ?? []),
      provenance: provenanceOf(entry),
    }));
  const byPackage: Record<string, string[]> = {};
  for (const concept of concepts) {
    byPackage[concept.package] = [
      ...(byPackage[concept.package] ?? []),
      concept.id,
    ];
  }
  const packages = materialize(t.packages);
  const graphNodes = packages.map((p) => ({
    analyzed: p.analyzed,
    anchored: p.anchored,
    package: p.id,
    provenance: p.provenance,
  }));
  const churn = materialize(t.churn).map((file) => ({
    ...file,
    observations: [...file.observations].sort((a, b) =>
      compare(a.source, b.source)
    ),
  }));

  const naive = {} as Record<WorkspaceEntityKind, number>;
  const canonical = {} as Record<WorkspaceEntityKind, number>;
  const density = {} as Record<
    WorkspaceEntityKind,
    WorkspaceObservationDensity
  >;
  const tableFor: Record<WorkspaceEntityKind, Table<unknown>> = {
    boundary: t.boundaries,
    churn: t.churn,
    concept: t.concepts,
    coupling: t.couplings,
    dependencyEdge: t.dependencyEdges,
    finding: t.findings,
    hotspot: t.hotspots,
    impact: t.impacts,
    module: t.modules,
    moduleEdge: t.moduleEdges,
    overlap: t.overlaps,
    package: t.packages,
    packageCoupling: t.packageCouplings,
    review: t.reviews,
    scenario: t.scenarios,
  };
  for (const kind of ENTITY_KINDS) {
    naive[kind] = ledger.naive.get(kind) ?? 0;
    canonical[kind] = tableFor[kind].entries.size;
    density[kind] = densityOf(tableFor[kind]);
  }
  // Package mentions are identity observations, not duplicated facts.
  naive.package = packages.length;

  const conflicts = [...ledger.conflicts].sort(
    (a, b) =>
      compare(a.entity, b.entity) ||
      compare(a.entityId, b.entityId) ||
      compare(a.field, b.field)
  );
  const diagnostics = [...ledger.diagnostics].sort(
    (a, b) =>
      compare(a.kind, b.kind) ||
      compare(a.source ?? "", b.source ?? "") ||
      compare(a.detail, b.detail)
  );

  return {
    architecture: {
      packages: materialize(t.architecture),
      recentering: {
        findings: materialize(t.findings),
        impacts: materialize(t.impacts),
        reviews: materialize(t.reviews),
        scenarios: materialize(t.scenarios),
      },
    },
    boundaries: { boundaries: materialize(t.boundaries) },
    concepts: { byPackage, concepts, overlaps: materialize(t.overlaps) },
    evolution: {
      churn,
      couplings: materialize(t.couplings),
      hotspots: materialize(t.hotspots),
      packageCouplings: materialize(t.packageCouplings),
      radius: materialize(t.radius),
    },
    graph: {
      dependencyEdges: materialize(t.dependencyEdges),
      moduleEdges: materialize(t.moduleEdges),
      modules: materialize(t.modules),
      packages: graphNodes,
    },
    ingestion: {
      canonical,
      canonicalBoundaries: canonical.boundary,
      canonicalConcepts: canonical.concept,
      canonicalModules: canonical.module,
      canonicalPackages: packages.length,
      conflicts,
      coverage: {
        missingPackages: missing,
        packagesAnalyzed: analyzed.length,
        packagesKnown: known.length,
        ...(population !== undefined && { population }),
        complete,
      },
      density,
      diagnostics,
      duplicates,
      naive,
      reportsAccepted: sources.length,
      reportsReceived: inputs.length,
      reportsRejected: rejected,
    },
    packages: { packages },
    sources: [...sources].sort((a, b) => compare(a.package, b.package)),
    workspace: {
      ...(options.root !== undefined && { root: options.root }),
      packageCount: packages.length,
      reportCount: sources.length,
    },
    workspaceSchemaVersion: WORKSPACE_SCHEMA_VERSION,
  };
}
