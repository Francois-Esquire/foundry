import type { ArchitecturalReviewDisposition } from "./types";
import type {
  WorkspaceConceptDirection,
  WorkspaceConceptPlacement,
} from "./workspace-concepts-types";
import { reviewGravityCenter } from "./workspace-patterns";
import type {
  WorkspacePatternEvidence,
  WorkspaceReviewContext,
} from "./workspace-patterns-types";
import type {
  ArchitecturalRoleProjection,
  ConceptDirectionProjection,
  ConceptDirectionRole,
  ProjectionCoverage,
  ProjectionDetail,
  ProjectionEntityKind,
  ProjectionEvidenceRef,
  ProjectionShare,
  WorkspaceBoundaryProjection,
  WorkspaceConceptProjection,
  WorkspaceConceptSummaryProjection,
  WorkspaceEntityResolution,
  WorkspaceLimitationProjection,
  WorkspaceOverviewProjection,
  WorkspacePackageProjection,
  WorkspacePackageSummaryProjection,
  WorkspacePatternIndexEntry,
  WorkspacePatternProjection,
  WorkspaceProjectionContext,
  WorkspaceProjectionIndex,
  WorkspaceProjectionLookup,
  WorkspaceProjectionManifest,
  WorkspaceQueryEntity,
  WorkspaceReviewContextProjection,
  WorkspaceReviewProjection,
  WorkspaceSearchMode,
  WorkspaceSearchProjection,
} from "./workspace-projection-types";
import { WORKSPACE_PROJECTION_SCHEMA_VERSION } from "./workspace-projection-types";
import type {
  WorkspaceArchitecturalReview,
  WorkspaceConcept,
  WorkspaceRecenteringScenario,
  WorkspaceReport,
} from "./workspace-types";
import { WORKSPACE_SCHEMA_VERSION } from "./workspace-types";

// V9.4 projection layer, part one: the context (indexes over V9.0–V9.3),
// the focused entity projections, name resolution, and the search index.
// Everything here copies canonical facts under canonical ids; nothing is
// inferred, ranked by a combined score, or reworded into advice. Pure
// functions of the context: no UI state, no terminal width, no randomness.

export function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(byId);
}

export function short(id: string): string {
  return id.replace(/^@[^/]+\//, "");
}

export function boundaryIdOf(from: string, to: string): string {
  return `${from}→${to}`;
}

function group<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list === undefined) {
      map.set(k, [item]);
    } else {
      list.push(item);
    }
  }
  return map;
}

function record(map: Map<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of [...map.keys()].sort(byId)) {
    out[key] = sorted(map.get(key) ?? []);
  }
  return out;
}

function ratio(count: number, total: number): number | null {
  return total > 0 ? count / total : null;
}

// ---------------------------------------------------------------------------
// CONTEXT

export const PATTERN_FAMILY_PREFIX = {
  boundary: "boundary:",
  concept: "concept:",
  evolutionary: "evolutionary:",
  "package-pair": "pair:",
  "package-role": "role:",
} as const;

function patternEntries(
  patterns: WorkspaceProjectionContext["patterns"]
): WorkspacePatternIndexEntry[] {
  const entries: WorkspacePatternIndexEntry[] = [];
  for (const profile of patterns.packages) {
    for (const role of profile.roles) {
      entries.push({
        boundaries: role.support.boundaries,
        conceptCount: role.support.conceptCount,
        concepts: role.support.concepts,
        coverage: role.coverage,
        family: "package-role",
        id: `${PATTERN_FAMILY_PREFIX["package-role"]}${role.kind}:${profile.package}`,
        kinds: [role.kind],
        packages: sorted([profile.package, ...role.sourcePackages]),
        sourceId: `${role.kind}:${profile.package}`,
        strength: role.strength,
      });
    }
  }
  for (const pair of patterns.packagePairs) {
    if (pair.patterns.length === 0) {
      continue;
    }
    entries.push({
      boundaries: pair.support.boundaries,
      conceptCount: pair.conceptCount,
      concepts: pair.support.concepts,
      coverage: pair.coverage,
      family: "package-pair",
      id: `${PATTERN_FAMILY_PREFIX["package-pair"]}${pair.id}`,
      kinds: pair.patterns,
      packages: sorted([pair.from, pair.to]),
      sourceId: pair.id,
      strength: pair.strength,
    });
  }
  for (const boundary of patterns.boundaries) {
    if (boundary.kinds.length === 0) {
      continue;
    }
    entries.push({
      boundaries: [boundary.boundaryId],
      conceptCount: boundary.conceptLoad,
      concepts: boundary.support.concepts,
      coverage: boundary.coverage,
      family: "boundary",
      id: `${PATTERN_FAMILY_PREFIX.boundary}${boundary.boundaryId}`,
      kinds: boundary.kinds,
      packages: sorted([boundary.from, boundary.to]),
      sourceId: boundary.boundaryId,
      strength: boundary.strength,
    });
  }
  for (const pattern of patterns.conceptPatterns) {
    entries.push({
      boundaries: pattern.support.boundaries,
      conceptCount: pattern.support.conceptCount,
      concepts: pattern.concepts,
      coverage: pattern.coverage,
      family: "concept",
      id: `${PATTERN_FAMILY_PREFIX.concept}${pattern.id}`,
      kinds: [pattern.kind],
      packages: pattern.packages,
      sourceId: pattern.id,
      strength: pattern.strength,
    });
  }
  for (const pattern of patterns.evolutionaryPatterns) {
    entries.push({
      boundaries: pattern.boundaries,
      conceptCount: pattern.concepts.length,
      concepts: pattern.concepts,
      coverage: pattern.coverage,
      family: "evolutionary",
      id: `${PATTERN_FAMILY_PREFIX.evolutionary}${pattern.id}`,
      kinds: pattern.kinds,
      packages: pattern.packages,
      sourceId: pattern.id,
      strength: pattern.strength,
    });
  }
  return entries.sort((a, b) => byId(a.id, b.id));
}

function entitiesOf(
  workspace: WorkspaceReport,
  patterns: WorkspacePatternIndexEntry[]
): WorkspaceQueryEntity[] {
  const entities: WorkspaceQueryEntity[] = [];
  for (const pkg of workspace.packages.packages) {
    const alias = short(pkg.id);
    entities.push({
      id: pkg.id,
      kind: "package",
      name: pkg.name,
      ...(alias !== pkg.id && { aliases: [alias] }),
    });
  }
  for (const concept of workspace.concepts.concepts) {
    entities.push({
      aliases: [`${short(concept.package)}:${concept.name}`],
      id: concept.id,
      kind: "concept",
      name: concept.name,
      package: concept.package,
    });
  }
  for (const boundary of workspace.boundaries.boundaries) {
    entities.push({
      aliases: sorted([
        `${short(boundary.from)}→${short(boundary.to)}`,
        `${boundary.from}->${boundary.to}`,
        `${short(boundary.from)}->${short(boundary.to)}`,
      ]),
      id: boundary.id,
      kind: "boundary",
      name: boundary.id,
    });
  }
  for (const pattern of patterns) {
    entities.push({ id: pattern.id, kind: "pattern", name: pattern.sourceId });
  }
  for (const review of workspace.architecture.recentering.reviews) {
    const concept = workspace.concepts.concepts.find(
      (c) => c.id === review.conceptId
    );
    entities.push({
      id: review.findingId,
      kind: "review",
      name: concept?.name ?? review.conceptId,
      ...(concept !== undefined && { package: concept.package }),
      aliases: [review.conceptId],
    });
  }
  return entities.sort((a, b) => byId(a.kind, b.kind) || byId(a.id, b.id));
}

function buildIndex(
  workspace: WorkspaceReport,
  patterns: WorkspacePatternIndexEntry[]
): WorkspaceProjectionIndex {
  const patternsByPackage = new Map<string, string[]>();
  const patternsByConcept = new Map<string, string[]>();
  const patternsByBoundary = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, id: string) => {
    const list = map.get(key);
    if (list === undefined) {
      map.set(key, [id]);
    } else {
      list.push(id);
    }
  };
  for (const pattern of patterns) {
    for (const pkg of pattern.packages) {
      push(patternsByPackage, pkg, pattern.id);
    }
    for (const c of pattern.concepts) {
      push(patternsByConcept, c, pattern.id);
    }
    for (const b of pattern.boundaries) {
      push(patternsByBoundary, b, pattern.id);
    }
  }
  const boundariesByPackage = new Map<string, string[]>();
  for (const boundary of workspace.boundaries.boundaries) {
    push(boundariesByPackage, boundary.from, boundary.id);
    push(boundariesByPackage, boundary.to, boundary.id);
  }
  const gravityCenterByFinding: Record<string, string> = {};
  for (const finding of [...workspace.architecture.recentering.findings].sort(
    (a, b) => byId(a.id, b.id)
  )) {
    const center = reviewGravityCenter(finding);
    if (center !== null) {
      gravityCenterByFinding[finding.id] = center;
    }
  }
  return {
    boundariesByPackage: record(boundariesByPackage),
    conceptsByPackage: workspace.concepts.byPackage,
    entities: entitiesOf(workspace, patterns),
    gravityCenterByFinding,
    patterns,
    patternsByBoundary: record(patternsByBoundary),
    patternsByConcept: record(patternsByConcept),
    patternsByPackage: record(patternsByPackage),
  };
}

function buildLookup(
  workspace: WorkspaceReport,
  context: Omit<WorkspaceProjectionContext, "index" | "lookup">,
  patterns: WorkspacePatternIndexEntry[]
): WorkspaceProjectionLookup {
  const { graph, concepts } = context;
  const recentering = workspace.architecture.recentering;
  return {
    boundaryById: new Map(
      workspace.boundaries.boundaries.map((b) => [b.id, b])
    ),
    boundaryPatternById: new Map(
      context.patterns.boundaries.map((b) => [b.boundaryId, b])
    ),
    conceptById: new Map(workspace.concepts.concepts.map((c) => [c.id, c])),
    edgeById: new Map(graph.edges.map((e) => [e.id, e])),
    findingById: new Map(recentering.findings.map((f) => [f.id, f])),
    graphNodeById: new Map(graph.packages.map((p) => [p.package, p])),
    impactByScenario: new Map(
      recentering.impacts.map((i) => [i.scenarioId, i])
    ),
    loadByBoundary: new Map(
      [...concepts.boundaries, ...concepts.seams].map((l) => [l.boundaryId, l])
    ),
    overlapById: new Map(workspace.concepts.overlaps.map((o) => [o.id, o])),
    pairPatternById: new Map(
      context.patterns.packagePairs.map((p) => [p.id, p])
    ),
    pairTopologyById: new Map(
      concepts.relationships.pairs.map((p) => [p.pair, p])
    ),
    patternById: new Map(patterns.map((p) => [p.id, p])),
    placementById: new Map(concepts.concepts.map((p) => [p.concept.id, p])),
    profileById: new Map(context.patterns.packages.map((p) => [p.package, p])),
    reviewByConcept: new Map(recentering.reviews.map((r) => [r.conceptId, r])),
    roleSummaryById: new Map(concepts.packageRoles.map((r) => [r.package, r])),
    scenarioById: new Map(recentering.scenarios.map((s) => [s.id, s])),
    scenariosByFinding: group(recentering.scenarios, (s) => s.findingId),
    seamIds: new Set(graph.seams.map((s) => s.id)),
  };
}

/** Requires every V9 layer attached (`analyzeWorkspace`); throws otherwise. */
export function createWorkspaceProjectionContext(
  workspace: WorkspaceReport
): WorkspaceProjectionContext {
  const intelligence = workspace.intelligence;
  const graph = intelligence?.graph;
  const concepts = intelligence?.concepts;
  const patterns = intelligence?.patterns;
  if (graph === undefined || concepts === undefined || patterns === undefined) {
    throw new Error(
      "workspace intelligence (graph, concepts, patterns) must be attached before projecting; run analyzeWorkspace first"
    );
  }
  if (workspace.workspaceSchemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    throw new Error(
      `workspace schema ${workspace.workspaceSchemaVersion} is not the projection layer's ${WORKSPACE_SCHEMA_VERSION}; re-ingest the package reports`
    );
  }
  const entries = patternEntries(patterns);
  const base = { concepts, graph, patterns, workspace };
  return {
    ...base,
    index: buildIndex(workspace, entries),
    lookup: buildLookup(workspace, base, entries),
  };
}

export function projectionCoverage(
  context: WorkspaceProjectionContext
): ProjectionCoverage {
  const coverage = context.workspace.ingestion.coverage;
  return {
    certainty: context.graph.certainty,
    missingPackages: coverage.missingPackages,
    packagesAnalyzed: coverage.packagesAnalyzed,
    packagesKnown: coverage.population ?? coverage.packagesKnown,
  };
}

export function workspaceProjectionManifest(
  context: WorkspaceProjectionContext
): WorkspaceProjectionManifest {
  return {
    availableScopes: ["workspace", "package", "concept", "boundary", "pattern"],
    matrices: [
      "package-concept-roles",
      "package-direction",
      "boundary-concept-load",
      "review",
    ],
    presets: [
      "architecture-overview",
      "dependency-topology",
      "structural-seam",
      "implementation-flow",
      "behavior-flow",
      "representation-flow",
      "usage-flow",
      "conversion-flow",
      "architecture-review",
    ],
    projectionSchemaVersion: WORKSPACE_PROJECTION_SCHEMA_VERSION,
    queryCapabilities: [
      "overview",
      "package",
      "concept",
      "boundary",
      "pattern",
      "review",
      "graph",
      "concept-graph",
      "matrix",
      "rank",
      "directions",
      "reviews",
      "search",
    ],
    workspaceSchemaVersion: context.workspace.workspaceSchemaVersion,
  };
}

// ---------------------------------------------------------------------------
// SHARED PIECES

const DIRECTION_ROLES: Record<
  WorkspaceConceptDirection["kind"],
  ConceptDirectionRole
> = {
  "semantic-to-behavior": "behavior",
  "semantic-to-conversion": "conversion",
  "semantic-to-implementation": "implementation",
  "semantic-to-representation": "representation",
  "semantic-to-usage": "usage",
};

export function directionRoleOf(
  kind: WorkspaceConceptDirection["kind"]
): ConceptDirectionRole {
  return DIRECTION_ROLES[kind];
}

export function staticDirectionOf(path: {
  forward: number | null;
  reverse: number | null;
  usageOnly: boolean;
}): ConceptDirectionProjection["staticDependencyDirection"] {
  if (path.forward !== null) {
    return "forward";
  }
  if (path.reverse !== null) {
    return "reverse";
  }
  if (path.usageOnly) {
    return "usage-only";
  }
  return "none";
}

export function projectDirection(
  direction: WorkspaceConceptDirection
): ConceptDirectionProjection {
  return {
    concepts: direction.concepts,
    count: direction.count,
    dependencyPath: {
      forward: direction.dependencyPath.forward,
      reverse: direction.dependencyPath.reverse,
    },
    from: direction.from,
    id: direction.id,
    role: directionRoleOf(direction.kind),
    staticDependencyDirection: staticDirectionOf(direction.dependencyPath),
    to: direction.to,
  };
}

export function byCountThenId<T extends { count: number; id: string }>(
  a: T,
  b: T
): number {
  return b.count - a.count || byId(a.id, b.id);
}

export function projectReviewContext(
  context: WorkspaceReviewContext
): WorkspaceReviewContextProjection {
  return {
    credibleAlternatives: context.credibleAlternatives,
    dispositions: context.dispositions,
    dominatedBaselines: context.dominatedBaselines,
    dominatingKinds: context.dominatingKinds,
    preserved: context.preserved,
    reviewed: context.reviewed,
  };
}

const EVIDENCE_SOURCES: Record<
  WorkspacePatternEvidence["source"],
  ProjectionEvidenceRef["source"]
> = {
  anchor: "workspace",
  boundary: "workspace",
  evolution: "workspace",
  "package-profile": "workspace",
  "v8-review": "v8-review",
  "workspace-concepts": "concept",
  "workspace-graph": "graph",
};

function refsOf(
  observations: WorkspacePatternEvidence[]
): ProjectionEvidenceRef[] {
  return observations.map((o) => ({
    entityIds: o.entities,
    kind: o.kind,
    source: EVIDENCE_SOURCES[o.source],
    ...(o.value !== undefined && { value: o.value }),
  }));
}

function limitation(
  kind: string,
  scope: WorkspaceLimitationProjection["scope"],
  entities: string[],
  detail: string
): WorkspaceLimitationProjection {
  return { detail, entities, kind, scope };
}

function reviewOf(
  context: WorkspaceProjectionContext,
  review: WorkspaceArchitecturalReview
): WorkspaceReviewProjection {
  const { lookup, index } = context;
  const finding = lookup.findingById.get(review.findingId);
  const baselineDominators = review.dominated.filter(
    (d) => d.scenarioId === review.baselineScenarioId
  );
  const kinds = baselineDominators
    .map((d) => lookup.scenarioById.get(d.dominatedBy)?.kind)
    .filter((k): k is WorkspaceRecenteringScenario["kind"] => k !== undefined);
  return {
    baselineDominated: baselineDominators.length > 0,
    baselineScenarioId: review.baselineScenarioId,
    conceptId: review.conceptId,
    declaredPackage: finding?.concept.package ?? "",
    disposition: review.disposition,
    dominatedScenarios: review.dominated.map((d) => ({
      dominatedBy: d.dominatedBy,
      scenarioId: d.scenarioId,
    })),
    dominatingKinds: sorted(kinds) as WorkspaceRecenteringScenario["kind"][],
    findingId: review.findingId,
    gravityCenter: index.gravityCenterByFinding[review.findingId] ?? null,
    invalidScenarios: review.invalid,
    unresolved: review.unresolved.map((u) => ({
      kind: u.kind,
      scenarioIds: u.scenarioIds,
    })),
    viableScenarios: review.viable,
  };
}

export function projectWorkspaceReview(
  context: WorkspaceProjectionContext,
  conceptId: string
): WorkspaceReviewProjection | undefined {
  const review = context.lookup.reviewByConcept.get(conceptId);
  return review === undefined ? undefined : reviewOf(context, review);
}

export function projectAllReviews(
  context: WorkspaceProjectionContext
): WorkspaceReviewProjection[] {
  return [...context.workspace.architecture.recentering.reviews]
    .sort((a, b) => byId(a.conceptId, b.conceptId))
    .map((r) => reviewOf(context, r));
}

// ---------------------------------------------------------------------------
// OVERVIEW

const STRENGTH_ORDER = { limited: 2, moderate: 1, strong: 0 } as const;

export function projectWorkspaceOverview(
  context: WorkspaceProjectionContext
): WorkspaceOverviewProjection {
  const { workspace, graph, concepts, patterns } = context;
  const bySummary = <
    T extends {
      count: number;
      strength: keyof typeof STRENGTH_ORDER;
      entityId: string;
    },
  >(
    a: T,
    b: T
  ) =>
    STRENGTH_ORDER[a.strength] - STRENGTH_ORDER[b.strength] ||
    b.count - a.count ||
    byId(a.entityId, b.entityId);
  const packageRoles = patterns.packages
    .flatMap((p) =>
      p.roles.map((r) => ({
        count: r.support.conceptCount,
        entityId: p.package,
        entityKind: "package" as const,
        kinds: [r.kind],
        strength: r.strength,
      }))
    )
    .sort(bySummary);
  const conceptPatterns = patterns.conceptPatterns
    .map((c) => ({
      count: c.support.conceptCount,
      entityId: `${PATTERN_FAMILY_PREFIX.concept}${c.id}`,
      entityKind: "pattern" as const,
      kinds: [c.kind],
      strength: c.strength,
    }))
    .sort(bySummary);
  const boundaryPatterns = patterns.boundaries
    .filter((b) => b.kinds.length > 0)
    .map((b) => ({
      count: b.conceptLoad,
      entityId: b.boundaryId,
      entityKind: "boundary" as const,
      kinds: b.kinds,
      strength: b.strength,
    }))
    .sort(bySummary);
  const reviews = workspace.architecture.recentering.reviews;
  const dispositions = (d: ArchitecturalReviewDisposition) =>
    reviews.filter((r) => r.disposition === d).length;
  const limitations = new Map<string, WorkspaceLimitationProjection>();
  const add = (l: WorkspaceLimitationProjection) => {
    limitations.set(`${l.kind}|${l.detail}`, l);
  };
  for (const gap of patterns.coveragePatterns) {
    add(limitation(gap.kind, "workspace", gap.entities, gap.detail));
  }
  for (const c of [
    ...graph.cautions,
    ...concepts.cautions,
    ...patterns.cautions,
  ]) {
    add(limitation(c.kind, "workspace", c.entities, c.detail));
  }
  return {
    architecture: {
      boundaryPatterns,
      conceptPatterns,
      packageRoles,
      statements: patterns.statements.map((s) => ({
        detail: s.detail,
        kind: s.kind,
        patternIds: s.patternIds,
      })),
      strength: {
        limited: patterns.summary.limited,
        moderate: patterns.summary.moderate,
        strong: patterns.summary.strong,
      },
    },
    coverage: projectionCoverage(context),
    limitations: [...limitations.values()],
    policyVersion: workspace.intelligence?.policyVersion ?? null,
    projectionSchemaVersion: WORKSPACE_PROJECTION_SCHEMA_VERSION,
    reviews: {
      credibleAlternatives: dispositions("credible-alternative"),
      dominatedBaselines: reviews.filter((r) =>
        r.dominated.some((d) => d.scenarioId === r.baselineScenarioId)
      ).length,
      insufficientEvidence: dispositions("insufficient-evidence"),
      intentBlocked: dispositions("intent-blocked"),
      preserveCurrent: dispositions("preserve-current"),
      reviewed: reviews.length,
      tradeoffs: dispositions("multiple-tradeoffs"),
    },
    topology: {
      articulation: graph.topology.articulationPackages,
      components: graph.topology.connectedComponents,
      cycles: graph.summary.cycles,
      isolated: graph.topology.packageIsolated,
      maxDepth: graph.layers.maxPackageDepth,
      seams: graph.seams.map((s) => s.id),
      sinks: graph.topology.packageSinks,
      sources: graph.topology.packageSources,
    },
    workspace: {
      analyzedPackages: workspace.ingestion.coverage.packagesAnalyzed,
      authoritativeConcepts: concepts.summary.authoritative,
      boundaries: workspace.boundaries.boundaries.length,
      conceptBearingBoundaries: concepts.summary.conceptBearingBoundaries,
      concepts: concepts.summary.concepts,
      conversionPairs: concepts.summary.conversionPairs,
      modules: graph.population.modules,
      overlapPairs: concepts.summary.overlapPairs,
      packages: workspace.packages.packages.length,
    },
    workspaceSchemaVersion: workspace.workspaceSchemaVersion,
  };
}

// ---------------------------------------------------------------------------
// PACKAGE

export function projectWorkspacePackage(
  context: WorkspaceProjectionContext,
  id: string,
  detail: ProjectionDetail = "standard"
): WorkspacePackageProjection | undefined {
  const { workspace, concepts, patterns, lookup, index } = context;
  const pkg = workspace.packages.packages.find((p) => p.id === id);
  if (pkg === undefined) {
    return undefined;
  }
  const node = lookup.graphNodeById.get(id);
  const profile = lookup.profileById.get(id);
  const summary = lookup.roleSummaryById.get(id);
  const roles: ArchitecturalRoleProjection[] = (profile?.roles ?? []).map(
    (r) => ({
      conceptCount: r.support.conceptCount,
      conceptIds: r.support.concepts,
      coverage: r.coverage,
      kind: r.kind,
      patternId: `${PATTERN_FAMILY_PREFIX["package-role"]}${r.kind}:${id}`,
      sourcePackages: r.sourcePackages,
      strength: r.strength,
    })
  );
  const directions = concepts.directions.map(projectDirection);
  const incoming = directions.filter((d) => d.to === id).sort(byCountThenId);
  const outgoing = directions.filter((d) => d.from === id).sort(byCountThenId);
  const boundaries = (index.boundariesByPackage[id] ?? []).flatMap((bid) => {
    const boundary = lookup.boundaryById.get(bid);
    if (boundary === undefined) {
      return [];
    }
    const edge = lookup.edgeById.get(bid);
    return [
      {
        boundaryId: bid,
        conceptCount: lookup.loadByBoundary.get(bid)?.conceptCount ?? 0,
        direction:
          boundary.from === id ? ("outgoing" as const) : ("incoming" as const),
        from: boundary.from,
        importSites: boundary.importSites,
        moduleEdges: boundary.moduleEdges,
        patterns: lookup.boundaryPatternById.get(bid)?.kinds ?? [],
        seam: lookup.seamIds.has(bid),
        severedPairs: edge?.severedPairs ?? null,
        to: boundary.to,
      },
    ];
  });
  const reviewPatterns = patterns.reviewPatterns;
  const declaring = reviewPatterns.find(
    (r) => r.scope === "package" && r.id === id
  );
  const gravity = reviewPatterns.find(
    (r) => r.scope === "gravity-center" && r.id === id
  );
  const reviewDirections = reviewPatterns
    .filter((r) => r.scope === "direction" && r.entityIds.includes(id))
    .map((r) => ({
      from: r.entityIds[0] ?? "",
      reviews: projectReviewContext(r.reviews),
      to: r.entityIds[1] ?? "",
    }));
  const cautions: WorkspaceLimitationProjection[] = [];
  if (!pkg.analyzed) {
    cautions.push(
      limitation(
        "package-not-analyzed",
        "package",
        [id],
        "No report for this package; it is known only as an edge or concept endpoint, so every count here is what other packages observed."
      )
    );
  }
  if (node === undefined) {
    cautions.push(
      limitation(
        "package-not-in-graph",
        "package",
        [id],
        "Not a node of the workspace package graph; no layer, reach, or structure facts."
      )
    );
  }
  const partialRoles = roles.filter((r) => r.coverage === "partial");
  if (partialRoles.length > 0) {
    cautions.push(
      limitation(
        "partial-coverage",
        "package",
        partialRoles.map((r) => r.patternId),
        "A supporting package of these roles was not analyzed; their counts are lower bounds."
      )
    );
  }
  const projection: WorkspacePackageProjection = {
    analyzed: pkg.analyzed,
    anchored: pkg.anchored,
    name: pkg.name,
    package: id,
    ...(pkg.anchorReason !== undefined && { anchorReason: pkg.anchorReason }),
    ...(node !== undefined && {
      graph: {
        articulation: node.articulation,
        betweenness: node.betweenness,
        component: node.component,
        cycle: node.cycle,
        dependencyReach: node.transitive.dependencies,
        dependencyReachShare: node.reach.dependencyShare,
        dependentReach: node.transitive.dependents,
        dependentReachShare: node.reach.dependentShare,
        fanIn: node.direct.fanIn,
        fanOut: node.direct.fanOut,
        layer: node.layer,
        role: node.role,
      },
    }),
    ...(pkg.surface !== undefined && {
      surface: {
        consumerPackages: pkg.surface.consumerPackages,
        dependencyPackages: pkg.surface.dependencyPackages,
        exportUtilization: pkg.surface.exportUtilization,
        externallyUsedSymbols: pkg.surface.externallyUsedSymbols,
        packagePublicSymbols: pkg.surface.packagePublicSymbols,
        shapeSignals: pkg.surface.shapeSignals,
        totalSymbols: pkg.surface.totalSymbols,
      },
    }),
    boundaries: boundaries.sort((a, b) => byId(a.boundaryId, b.boundaryId)),
    cautions,
    concepts: {
      behaviorCenters: summary?.behaviorCenters ?? 0,
      conversionsOwned: profile?.counts.conversionsOwned ?? 0,
      declared: summary?.declaredConcepts ?? 0,
      declaredCrossPackage: profile?.counts.declaredCrossPackage ?? 0,
      evolutionCenters: summary?.evolutionCenters ?? 0,
      foreign: {
        behaved: profile?.counts.foreignBehaved ?? 0,
        converted: profile?.counts.foreignConverted ?? 0,
        implemented: profile?.counts.foreignImplemented ?? 0,
        represented: profile?.counts.foreignRepresented ?? 0,
        sources: profile?.counts.foreignSources ?? 0,
        used: profile?.counts.foreignUsed ?? 0,
      },
      implementationCenters: summary?.implementationCenters ?? 0,
      participating: summary?.participating ?? {
        behaving: 0,
        converting: 0,
        implementing: 0,
        representing: 0,
        total: 0,
        using: 0,
      },
      representationCenters: summary?.representationCenters ?? 0,
      semanticCenters: summary?.semanticCenters ?? 0,
      usageCenters: summary?.usageCenters ?? 0,
    },
    coverage: projectionCoverage(context),
    incomingDirections: incoming,
    outgoingDirections: outgoing,
    patterns: index.patternsByPackage[id] ?? [],
    profileSignals: profile?.profileSignals ?? [],
    reviews: {
      ...(declaring !== undefined && {
        asDeclaringPackage: projectReviewContext(declaring.reviews),
      }),
      ...(gravity !== undefined && {
        asGravityCenter: projectReviewContext(gravity.reviews),
      }),
      directions: reviewDirections,
    },
    roles,
  };
  if (detail !== "evidence") {
    return projection;
  }
  const refs: ProjectionEvidenceRef[] = [];
  if (node !== undefined) {
    refs.push({ entityIds: [id], kind: "package-node", source: "graph" });
  }
  for (const role of profile?.roles ?? []) {
    refs.push({
      entityIds: role.support.concepts,
      kind: role.kind,
      source: "pattern",
      value: role.support.conceptCount,
    });
    refs.push(...refsOf(role.support.observations));
  }
  for (const d of [...incoming, ...outgoing]) {
    refs.push({
      entityIds: [d.id],
      kind: "direction",
      source: "concept",
      value: d.count,
    });
  }
  for (const b of boundaries) {
    refs.push({
      entityIds: [b.boundaryId],
      kind: "boundary",
      source: "workspace",
    });
  }
  for (const r of [declaring, gravity]) {
    if (r !== undefined) {
      refs.push({
        entityIds: [
          ...r.reviews.dominatedBaselines,
          ...r.reviews.credibleAlternatives,
          ...r.reviews.preserved,
        ],
        kind: `review-pattern:${r.scope}`,
        source: "v8-review",
        value: r.reviews.reviewed,
      });
    }
  }
  return { ...projection, evidenceRefs: refs };
}

export function summarizeWorkspacePackage(
  projection: WorkspacePackageProjection
): WorkspacePackageSummaryProjection {
  return {
    analyzed: projection.analyzed,
    boundaries: projection.boundaries.length,
    cautions: projection.cautions.map((c) => c.kind),
    concepts: {
      declared: projection.concepts.declared,
      participating: projection.concepts.participating.total,
    },
    coverage: projection.coverage,
    directions: {
      incoming: projection.incomingDirections.length,
      outgoing: projection.outgoingDirections.length,
    },
    package: projection.package,
    patterns: projection.patterns.length,
    reviewed:
      (projection.reviews.asDeclaringPackage?.reviewed ?? 0) +
      (projection.reviews.asGravityCenter?.reviewed ?? 0),
    roles: projection.roles.map((r) => ({
      conceptCount: r.conceptCount,
      kind: r.kind,
      strength: r.strength,
    })),
  };
}

// ---------------------------------------------------------------------------
// CONCEPT

function largestShare(
  rows: { package: string; count: number }[]
): ProjectionShare | null {
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const top = [...rows].sort(
    (a, b) => b.count - a.count || byId(a.package, b.package)
  )[0];
  if (top === undefined || top.count === 0) {
    return null;
  }
  return {
    count: top.count,
    package: top.package,
    share: ratio(top.count, total),
    total,
  };
}

function participationOf(
  placement: WorkspaceConceptPlacement,
  canonical: WorkspaceConcept
): WorkspaceConceptProjection["participation"] {
  const packages = sorted([
    ...placement.presence.packages,
    ...(canonical.ownership?.participation ?? []).map((p) => p.package),
    ...(canonical.locality?.behavior ?? []).map((b) => b.package),
  ]);
  const layers = new Map(
    placement.topology.packageLayers.map((l) => [l.package, l.layer])
  );
  return packages.map((pkg) => {
    const own = canonical.ownership?.participation.find(
      (p) => p.package === pkg
    );
    const beh = canonical.locality?.behavior.find((b) => b.package === pkg);
    return {
      contractBehaviors: beh?.contractBehaviors ?? 0,
      conversionBehaviors: beh?.conversionBehaviors ?? 0,
      conversions: own?.conversions ?? 0,
      implementationBehaviors: beh?.implementationBehaviors ?? 0,
      implementations: own?.implementations ?? 0,
      layer: layers.get(pkg) ?? null,
      package: pkg,
      references: own?.references ?? 0,
      representations: own?.representations ?? 0,
      roles:
        placement.presence.roles.find((r) => r.package === pkg)?.roles ?? [],
      sourceBehaviors: beh?.sourceBehaviors ?? 0,
      storyBehaviors: beh?.storyBehaviors ?? 0,
      testBehaviors: beh?.testBehaviors ?? 0,
    };
  });
}

export function projectWorkspaceConcept(
  context: WorkspaceProjectionContext,
  id: string,
  detail: ProjectionDetail = "standard"
): WorkspaceConceptProjection | undefined {
  const { lookup, index } = context;
  const placement = lookup.placementById.get(id);
  const canonical = lookup.conceptById.get(id);
  if (placement === undefined || canonical === undefined) {
    return undefined;
  }
  const behaviorRows = canonical.locality?.behavior ?? [];
  const sum = (key: keyof (typeof behaviorRows)[number]) =>
    behaviorRows.reduce((s, r) => s + Number(r[key]), 0);
  const referenceShare: ProjectionShare | null =
    canonical.distribution?.primaryPackage === undefined
      ? null
      : {
          count:
            canonical.ownership?.participation.find(
              (p) => p.package === canonical.distribution?.primaryPackage
            )?.references ?? null,
          package: canonical.distribution.primaryPackage,
          share: canonical.distribution.primaryShare,
          total: canonical.distribution.references,
        };
  const behaviorShare: ProjectionShare | null =
    canonical.locality?.primaryPackage === undefined
      ? null
      : {
          count:
            behaviorRows.find(
              (b) => b.package === canonical.locality?.primaryPackage
            )?.sourceBehaviors ?? null,
          package: canonical.locality.primaryPackage,
          share: canonical.locality.primaryPackageShare,
          total: sum("sourceBehaviors"),
        };
  const overlaps = placement.relationships.overlaps.map((rel) => {
    const overlap = lookup.overlapById.get(rel.pair);
    const other =
      overlap === undefined
        ? undefined
        : overlap.left.id === rel.other
          ? overlap.left
          : overlap.right;
    const pair = lookup.pairTopologyById.get(rel.pair);
    return {
      bidirectionalConversion: rel.bidirectionalConversion,
      conversions: rel.conversions.map((c) => ({
        direction: c.direction,
        function: c.function,
        package: c.package,
      })),
      crossPackage: rel.crossPackage,
      other: rel.other,
      otherName: other?.name ?? rel.other.split("#").pop() ?? rel.other,
      otherPackage: rel.otherPackage,
      pair: rel.pair,
      shapes: rel.shapes,
      ...(pair !== undefined && {
        path: {
          directEdge: pair.directEdge,
          forward: pair.path.forward,
          reverse: pair.path.reverse,
        },
      }),
    };
  });
  const finding =
    canonical.recentering?.findingId === undefined
      ? undefined
      : lookup.findingById.get(canonical.recentering.findingId);
  const scenarios = (
    finding === undefined
      ? []
      : (lookup.scenariosByFinding.get(finding.id) ?? [])
  )
    .slice()
    .sort((a, b) => byId(a.id, b.id))
    .map((s) => {
      const impact = lookup.impactByScenario.get(s.id);
      return {
        confidence: s.confidence,
        constraints: s.constraints,
        id: s.id,
        kind: s.kind,
        proposedCenter: s.proposedCenter,
        status: s.status,
        ...(impact !== undefined && {
          impact: {
            certainty: impact.certainty,
            changes: impact.changes,
            status: impact.status,
            uncertainties: impact.uncertainties,
            unmeasuredEdges: impact.unmeasuredEdges,
          },
        }),
      };
    });
  const review = projectWorkspaceReview(context, id);
  const evolution = placement.evolution;
  const projection: WorkspaceConceptProjection = {
    concept: placement.concept,
    coverage: placement.coverage,
    ...(placement.centers !== undefined && {
      centers: {
        ...(placement.centers.semantic !== undefined && {
          semantic: placement.centers.semantic,
        }),
        ...(placement.centers.representation !== undefined && {
          representation: placement.centers.representation,
        }),
        ...(placement.centers.usage !== undefined && {
          usage: placement.centers.usage,
        }),
        ...(placement.centers.behavior !== undefined && {
          behavior: placement.centers.behavior,
        }),
        ...(placement.centers.evolution !== undefined && {
          evolution: placement.centers.evolution,
        }),
        implementations: placement.centers.implementations,
        layers: {
          ...(placement.centers.graphContext.semanticLayer !== undefined && {
            semantic: placement.centers.graphContext.semanticLayer,
          }),
          ...(placement.centers.graphContext.representationLayer !==
            undefined && {
            representation: placement.centers.graphContext.representationLayer,
          }),
          ...(placement.centers.graphContext.usageLayer !== undefined && {
            usage: placement.centers.graphContext.usageLayer,
          }),
          ...(placement.centers.graphContext.behaviorLayer !== undefined && {
            behavior: placement.centers.graphContext.behaviorLayer,
          }),
        },
      },
    }),
    ...(canonical.ownership !== undefined && {
      ownership: {
        alignment: canonical.ownership.alignment,
        tensions: canonical.ownership.tensions,
      },
    }),
    ...(canonical.distribution !== undefined && {
      distribution: {
        modules: canonical.distribution.moduleCount,
        packages: canonical.distribution.packages.length,
        references: referenceShare,
        representations: largestShare(
          (canonical.representations?.byPackage ?? []).map((r) => ({
            count: r.representations,
            package: r.package,
          }))
        ),
        shapes: canonical.distribution.shapes,
        sourceBehavior: behaviorShare,
      },
    }),
    ...(canonical.locality !== undefined && {
      locality: {
        anchored: canonical.locality.anchored,
        behavior: {
          contract: sum("contractBehaviors"),
          conversion: sum("conversionBehaviors"),
          implementation: sum("implementationBehaviors"),
          source: sum("sourceBehaviors"),
          story: sum("storyBehaviors"),
          test: sum("testBehaviors"),
        },
        modifiers: canonical.locality.modifiers,
        moduleCount: canonical.locality.moduleCount,
        packageBoundaryCount: canonical.locality.packageBoundaryCount,
        packageCount: canonical.locality.packageCount,
        shape: canonical.locality.shape,
        sourceModuleCount: canonical.locality.sourceModuleCount,
      },
    }),
    extent: placement.extent,
    flow: placement.flow,
    participation: participationOf(placement, canonical),
    presence: placement.presence,
    propagation: placement.propagation,
    relationships: {
      conversionPairs: placement.relationships.conversions.length,
      overlapPairs: overlaps.length,
      overlaps,
    },
    shapes: placement.shapes,
    span: placement.span,
    topology: {
      components: placement.topology.components,
      disconnectedPackages: placement.topology.disconnectedPackages,
      edges: placement.topology.edges.map((e) => ({
        alternativeRoutes: e.structure.alternativeRoutes,
        from: e.from,
        fromDeclared: e.fromDeclared,
        id: e.id,
        importSites: e.volume.importSites,
        moduleEdges: e.volume.moduleEdges,
        references: e.volume.references,
        roles: e.roles,
        seam: e.structure.seam,
        severedPairs: e.structure.severedPairs,
        to: e.to,
        toDeclared: e.toDeclared,
      })),
      layers: placement.topology.packageLayers,
      participatingPackages: placement.topology.participatingPackages,
      paths: placement.topology.paths,
      unknownPackages: placement.topology.unknownPackages,
      usageOnlyEdges: placement.topology.usageOnlyEdges,
    },
    ...(evolution !== undefined && {
      evolution: {
        coChangeCommits: evolution.strongMemberCouplings.reduce(
          (s, c) => s + c.coChangeCommits,
          0
        ),
        contextualCouplings: evolution.contextualCouplings.length,
        crossPackageCouplings: evolution.crossPackageCouplings,
        historicallyActivePackages: evolution.historicallyActivePackages,
        hotspotModules: canonical.evolution?.hotspotModules ?? [],
        hotspotPackages: evolution.hotspotPackages,
        strongMemberCouplings: evolution.strongMemberCouplings.map((c) => ({
          coChangeCommits: c.coChangeCommits,
          context: c.context,
          dependencyPath: c.dependencyPath,
          id: c.id,
          jaccard: c.jaccard,
          left: c.left,
          leftPackage: c.leftPackage,
          right: c.right,
          rightPackage: c.rightPackage,
          scope: c.scope,
          staticPath: c.staticPath,
        })),
      },
    }),
    ...(canonical.recentering !== undefined && {
      recentering: {
        status: canonical.recentering.status,
        ...(finding !== undefined && {
          finding: {
            anchored: finding.anchored,
            evidenceConfidence: finding.evidenceConfidence,
            id: finding.id,
            mismatch: finding.mismatch,
            observedCenters: finding.observedCenters.map((c) => ({
              gravity: c.gravity,
              target: c.target,
            })),
            signal: finding.signal,
          },
        }),
        scenarios,
        ...(review !== undefined && { review }),
      },
    }),
    cautions: placement.cautions.map((c) =>
      limitation(c.kind, "concept", c.entities, c.detail)
    ),
    patterns: index.patternsByConcept[id] ?? [],
  };
  if (detail !== "evidence") {
    return projection;
  }
  const refs: ProjectionEvidenceRef[] = [
    { entityIds: [id], kind: "concept", source: "workspace" },
    ...placement.presence.roles.map((r) => ({
      entityIds: [r.package],
      kind: "package-role",
      source: "concept" as const,
      value: r.roles.join(","),
    })),
    ...placement.topology.edges.flatMap((e) =>
      e.evidence.map((ev) => ({
        entityIds: ev.entities,
        kind: ev.kind,
        source: "concept" as const,
        ...(ev.value !== undefined && { value: ev.value }),
      }))
    ),
    ...overlaps.map((o) => ({
      entityIds: [o.pair],
      kind: "overlap",
      source: "workspace" as const,
    })),
    ...(evolution?.strongMemberCouplings ?? []).map((c) => ({
      entityIds: [c.id],
      kind: "coupling",
      source: "workspace" as const,
      value: c.coChangeCommits,
    })),
    ...(index.patternsByConcept[id] ?? []).map((p) => ({
      entityIds: [p],
      kind: "pattern",
      source: "pattern" as const,
    })),
  ];
  if (finding !== undefined) {
    refs.push({
      entityIds: [finding.id],
      kind: "finding",
      source: "v8-review",
    });
  }
  if (review !== undefined) {
    refs.push({
      entityIds: [review.findingId],
      kind: "review",
      source: "v8-review",
      value: review.disposition,
    });
  }
  return { ...projection, evidenceRefs: refs };
}

export function summarizeWorkspaceConcept(
  projection: WorkspaceConceptProjection
): WorkspaceConceptSummaryProjection {
  const { centers } = projection;
  return {
    concept: projection.concept,
    coverage: projection.coverage,
    ...(centers !== undefined && {
      centers: {
        ...(centers.semantic !== undefined && { semantic: centers.semantic }),
        ...(centers.representation !== undefined && {
          representation: centers.representation,
        }),
        ...(centers.usage !== undefined && { usage: centers.usage }),
        ...(centers.behavior !== undefined && { behavior: centers.behavior }),
        implementations: centers.implementations,
      },
    }),
    ...(projection.ownership !== undefined && {
      ownershipAlignment: projection.ownership.alignment,
    }),
    ...(projection.locality !== undefined && {
      localityShape: projection.locality.shape,
    }),
    boundaries: projection.span.boundaryCount,
    packages: projection.presence.packages.length,
    propagation: projection.propagation,
    shapes: projection.shapes,
    ...(projection.recentering?.review !== undefined && {
      reviewDisposition: projection.recentering.review.disposition,
    }),
    cautions: projection.cautions.map((c) => c.kind),
    patterns: projection.patterns.length,
  };
}

// ---------------------------------------------------------------------------
// BOUNDARY

export function projectWorkspaceBoundary(
  context: WorkspaceProjectionContext,
  id: string,
  detail: ProjectionDetail = "standard"
): WorkspaceBoundaryProjection | undefined {
  const { lookup, patterns, workspace } = context;
  const boundary = lookup.boundaryById.get(id);
  if (boundary === undefined) {
    return undefined;
  }
  const edge = lookup.edgeById.get(id);
  const load = lookup.loadByBoundary.get(id);
  const pattern = lookup.boundaryPatternById.get(id);
  const pairKey = [boundary.from, boundary.to].sort(byId).join("|");
  const evolution = patterns.evolutionaryPatterns.find((e) => e.id === pairKey);
  const layer = (pkg: string) => lookup.graphNodeById.get(pkg)?.layer ?? null;
  const concepts = load?.concepts ?? [];
  const cautions: WorkspaceLimitationProjection[] = [];
  if (edge === undefined) {
    cautions.push(
      limitation(
        "usage-only-boundary",
        "boundary",
        [id],
        "No import module edge; the destination saw usage through re-exports only, so the boundary is not a package-graph edge and has no structure facts."
      )
    );
  }
  const unanalyzed = [boundary.from, boundary.to].filter(
    (p) => !workspace.packages.packages.find((k) => k.id === p)?.analyzed
  );
  if (unanalyzed.length > 0) {
    cautions.push(
      limitation(
        "partial-coverage",
        "boundary",
        unanalyzed,
        "An endpoint package was not analyzed; concept counts are what the other side observed."
      )
    );
  }
  if (boundary.perspectives.destination === undefined) {
    cautions.push(
      limitation(
        "source-perspective-only",
        "boundary",
        [id],
        "Only the importing package observed this boundary; symbol references and surface coverage are unknown."
      )
    );
  }
  const projection: WorkspaceBoundaryProjection = {
    boundaryId: id,
    concepts: {
      behavior: load?.roles.behavior ?? 0,
      conceptIds: concepts,
      conversion: load?.roles.conversion ?? 0,
      implementation: load?.roles.implementation ?? 0,
      representation: load?.roles.representation ?? 0,
      semanticUse: load?.roles.semanticUse ?? 0,
      total: load?.conceptCount ?? 0,
    },
    from: boundary.from,
    layers: { from: layer(boundary.from), to: layer(boundary.to) },
    patterns: {
      coverage: pattern?.coverage ?? null,
      kinds: pattern?.kinds ?? [],
      patternId:
        pattern === undefined || pattern.kinds.length === 0
          ? null
          : `${PATTERN_FAMILY_PREFIX.boundary}${id}`,
      strength: pattern?.strength ?? null,
    },
    ratios: {
      conceptsPerImportSite: {
        concepts: load?.conceptCount ?? 0,
        importSites: boundary.importSites,
        value: ratio(load?.conceptCount ?? 0, boundary.importSites),
      },
    },
    structure: {
      alternativeRoutes: edge?.alternativeRoutes ?? null,
      betweenness: edge?.betweenness ?? null,
      inPackageGraph: edge !== undefined,
      seam: lookup.seamIds.has(id),
      severedPairs: edge?.severedPairs ?? null,
      weakBridge: edge?.weakBridge ?? false,
    },
    to: boundary.to,
    verified: boundary.verified,
    volume: {
      breadth: boundary.breadth,
      distinctSymbols: boundary.symbols.distinct,
      importSites: boundary.importSites,
      moduleEdges: boundary.moduleEdges,
      packagePublicSymbols: boundary.symbols.packagePublic,
      references: boundary.symbols.references,
      surfaceCoverage: boundary.surfaceCoverage,
      usage: {
        bothSymbols: boundary.usage.bothSymbols,
        typeOnlySymbols: boundary.usage.typeOnlySymbols,
        valueOnlySymbols: boundary.usage.valueOnlySymbols,
      },
    },
    ...(evolution !== undefined && {
      evolution: {
        coChangeCommits: evolution.coChangeCommits,
        concepts: evolution.concepts,
        couplings: evolution.couplings,
        kinds: evolution.kinds,
        patternId: `${PATTERN_FAMILY_PREFIX.evolutionary}${evolution.id}`,
      },
    }),
    cautions,
    coverage: projectionCoverage(context),
  };
  if (detail !== "evidence") {
    return projection;
  }
  const refs: ProjectionEvidenceRef[] = [
    { entityIds: [id], kind: "boundary", source: "workspace" },
  ];
  if (edge !== undefined) {
    refs.push({ entityIds: [id], kind: "package-edge", source: "graph" });
  }
  if (concepts.length > 0) {
    refs.push({
      entityIds: concepts,
      kind: "boundary-concepts",
      source: "concept",
      value: concepts.length,
    });
  }
  if (pattern !== undefined) {
    refs.push(...refsOf(pattern.support.observations));
  }
  if (evolution !== undefined) {
    refs.push({
      entityIds: evolution.couplings,
      kind: "couplings",
      source: "workspace",
      value: evolution.coChangeCommits,
    });
  }
  return { ...projection, evidenceRefs: refs };
}

// ---------------------------------------------------------------------------
// PATTERN

type Structure = WorkspacePatternProjection["structure"];

function patternDetail(
  context: WorkspaceProjectionContext,
  entry: WorkspacePatternIndexEntry
): {
  structure: Structure;
  reviews?: WorkspaceReviewContextProjection;
  observations: WorkspacePatternEvidence[];
  headline: string;
} {
  const { patterns, lookup } = context;
  const label = (ids: string[]) => ids.map(short).join(", ");
  switch (entry.family) {
    case "package-role": {
      const split = entry.sourceId.indexOf(":");
      const kind = entry.sourceId.slice(0, split);
      const pkg = entry.sourceId.slice(split + 1);
      const role = lookup.profileById
        .get(pkg)
        ?.roles.find((r) => r.kind === kind);
      const profile = lookup.profileById.get(pkg);
      return {
        structure: {
          directionTargets: profile?.counts.directionTargets ?? 0,
          package: pkg,
          role: kind,
          sourcePackages: role?.sourcePackages ?? [],
        },
        ...(profile?.reviews !== undefined && {
          reviews: projectReviewContext(profile.reviews),
        }),
        headline: `${short(pkg)} · ${kind} · ${entry.conceptCount} concepts from ${role?.sourcePackages.length ?? 0} packages`,
        observations: role?.support.observations ?? [],
      };
    }
    case "package-pair": {
      const pair = lookup.pairPatternById.get(entry.sourceId);
      return {
        structure: {
          behavior: pair?.conceptRoles.behavior ?? [],
          conversion: pair?.conceptRoles.conversion ?? [],
          conversionPairs: pair?.conversionPairs ?? [],
          couplings: pair?.evolution.couplings ?? [],
          directEdge: pair?.graph.directEdge ?? null,
          from: pair?.from ?? "",
          implementation: pair?.conceptRoles.implementation ?? [],
          representation: pair?.conceptRoles.representation ?? [],
          staticForward: pair?.graph.forward ?? null,
          staticReverse: pair?.graph.reverse ?? null,
          to: pair?.to ?? "",
          usage: pair?.conceptRoles.usage ?? [],
          usageOnly: pair?.graph.usageOnly ?? false,
        },
        ...(pair?.reviews !== undefined && {
          reviews: projectReviewContext(pair.reviews),
        }),
        headline: `${short(pair?.from ?? "")} → ${short(pair?.to ?? "")} · ${entry.kinds.join(", ")} · ${entry.conceptCount} concepts`,
        observations: pair?.support.observations ?? [],
      };
    }
    case "boundary": {
      const boundary = lookup.boundaryPatternById.get(entry.sourceId);
      return {
        headline: `${short(boundary?.from ?? "")}→${short(boundary?.to ?? "")} · ${entry.kinds.join(", ")} · ${entry.conceptCount} concepts · ${boundary?.graph.importSites ?? boundary?.graph.moduleEdges ?? 0} ${boundary?.graph.importSites === null ? "module edges" : "import sites"}`,
        observations: boundary?.support.observations ?? [],
        structure: {
          alternativeRoutes: boundary?.graph.alternativeRoutes ?? 0,
          behavior: boundary?.roleLoad.behavior ?? 0,
          conversion: boundary?.roleLoad.conversion ?? 0,
          couplings: boundary?.evolution.couplings ?? [],
          from: boundary?.from ?? "",
          implementation: boundary?.roleLoad.implementation ?? 0,
          importSites: boundary?.graph.importSites ?? null,
          moduleEdges: boundary?.graph.moduleEdges ?? 0,
          representation: boundary?.roleLoad.representation ?? 0,
          seam: boundary?.graph.seam ?? false,
          semanticUse: boundary?.roleLoad.semanticUse ?? 0,
          severedPairs: boundary?.graph.severedPairs ?? 0,
          to: boundary?.to ?? "",
        },
      };
    }
    case "concept": {
      const pattern = patterns.conceptPatterns.find(
        (c) => c.id === entry.sourceId
      );
      return {
        structure: { ...(pattern?.structure ?? {}) },
        ...(pattern?.reviews !== undefined && {
          reviews: projectReviewContext(pattern.reviews),
        }),
        headline: `${entry.kinds.join(", ")} · ${entry.conceptCount} concepts · ${label(entry.packages)}`,
        observations: pattern?.support.observations ?? [],
      };
    }
    case "evolutionary": {
      const pattern = patterns.evolutionaryPatterns.find(
        (e) => e.id === entry.sourceId
      );
      return {
        headline: `${label(entry.packages).replace(", ", " ↔ ")} · ${entry.kinds.join(", ")} · ${pattern?.couplings.length ?? 0} couplings · ${pattern?.coChangeCommits ?? 0} commits`,
        observations: pattern?.support.observations ?? [],
        structure: {
          boundaries: entry.boundaries,
          coChangeCommits: pattern?.coChangeCommits ?? 0,
          couplings: pattern?.couplings ?? [],
          packages: entry.packages,
        },
      };
    }
  }
}

export function projectWorkspacePattern(
  context: WorkspaceProjectionContext,
  id: string,
  detail: ProjectionDetail = "standard"
): WorkspacePatternProjection | undefined {
  const entry = context.lookup.patternById.get(id);
  if (entry === undefined) {
    return undefined;
  }
  const found = patternDetail(context, entry);
  const statements = context.patterns.statements.filter(
    (s) => s.patternIds.includes(entry.sourceId) || s.patternIds.includes(id)
  );
  const cautions: WorkspaceLimitationProjection[] = [];
  if (entry.coverage === "partial") {
    cautions.push(
      limitation(
        "partial-coverage",
        "pattern",
        entry.packages,
        "A supporting package was not analyzed; support counts are lower bounds."
      )
    );
  }
  const evidenceRefs = refsOf(found.observations);
  const projection: WorkspacePatternProjection = {
    boundaries: entry.boundaries,
    conceptCount: entry.conceptCount,
    concepts: entry.concepts,
    coverage: entry.coverage,
    family: entry.family,
    id,
    kinds: entry.kinds,
    packages: entry.packages,
    strength: entry.strength,
    structure: found.structure,
    ...(found.reviews !== undefined && { reviews: found.reviews }),
    cautions,
    insight: {
      detail: [
        `${entry.strength} evidence · ${entry.coverage} coverage`,
        ...statements.map((s) => s.detail),
      ],
      evidenceRefs: detail === "summary" ? [] : evidenceRefs,
      headline: found.headline,
      support: { count: entry.conceptCount, entityIds: entry.concepts },
    },
  };
  return detail === "evidence" ? { ...projection, evidenceRefs } : projection;
}

export function listWorkspacePatterns(
  context: WorkspaceProjectionContext,
  filter: {
    family?: WorkspacePatternIndexEntry["family"];
    kind?: string;
    package?: string;
    strength?: WorkspacePatternIndexEntry["strength"];
  } = {}
): WorkspacePatternIndexEntry[] {
  return context.index.patterns.filter(
    (p) =>
      (filter.family === undefined || p.family === filter.family) &&
      (filter.kind === undefined || p.kinds.includes(filter.kind)) &&
      (filter.package === undefined || p.packages.includes(filter.package)) &&
      (filter.strength === undefined || p.strength === filter.strength)
  );
}

// ---------------------------------------------------------------------------
// SEARCH AND RESOLUTION

function matches(
  entity: WorkspaceQueryEntity,
  needle: string,
  mode: WorkspaceSearchMode
): boolean {
  const keys = [entity.id, entity.name, ...(entity.aliases ?? [])].map((k) =>
    k.toLowerCase()
  );
  switch (mode) {
    case "exact":
      return keys.includes(needle);
    case "prefix":
      return keys.some((k) => k.startsWith(needle));
    case "contains":
      return keys.some((k) => k.includes(needle));
  }
}

export function searchWorkspace(
  context: WorkspaceProjectionContext,
  text: string,
  options: { mode?: WorkspaceSearchMode; kinds?: ProjectionEntityKind[] } = {}
): WorkspaceSearchProjection {
  const mode = options.mode ?? "contains";
  const kinds = options.kinds ?? null;
  const needle = text.toLowerCase();
  return {
    kinds,
    matches: context.index.entities.filter(
      (e) =>
        (kinds === null || kinds.includes(e.kind)) && matches(e, needle, mode)
    ),
    mode,
    text,
  };
}

/** Exact id first; then exact name or alias. Several matches are returned, never chosen among. */
export function resolveWorkspaceEntity(
  context: WorkspaceProjectionContext,
  text: string,
  kind?: ProjectionEntityKind
): WorkspaceEntityResolution {
  const pool = context.index.entities.filter(
    (e) => kind === undefined || e.kind === kind
  );
  const exact = pool.find((e) => e.id === text);
  if (exact !== undefined) {
    return { entity: exact, status: "resolved" };
  }
  const named = pool.filter(
    (e) => e.name === text || (e.aliases ?? []).includes(text)
  );
  if (named.length === 1 && named[0] !== undefined) {
    return { entity: named[0], status: "resolved" };
  }
  if (named.length > 1) {
    return { candidates: named, status: "ambiguous" };
  }
  return { status: "not-found" };
}
