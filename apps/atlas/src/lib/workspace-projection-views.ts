import type { WorkspaceConceptPackageRole } from "./workspace-concepts-types";
import {
  boundaryIdOf,
  byCountThenId,
  byId,
  projectAllReviews,
  projectDirection,
  projectionCoverage,
  projectReviewContext,
  projectWorkspaceBoundary,
  projectWorkspaceConcept,
  projectWorkspaceOverview,
  projectWorkspacePackage,
  projectWorkspacePattern,
  projectWorkspaceReview,
  resolveWorkspaceEntity,
  searchWorkspace,
  short,
  sorted,
  summarizeWorkspaceConcept,
  summarizeWorkspacePackage,
} from "./workspace-projection";
import type {
  ConceptDirectionFilter,
  ConceptDirectionRole,
  ConceptGraphEdge,
  ConceptGraphEdgeKind,
  ConceptGraphNode,
  ProjectionAxisEntity,
  ReviewListFilter,
  WorkspaceConceptGraphProjection,
  WorkspaceDependencyEdgeProjection,
  WorkspaceDirectionEdgeProjection,
  WorkspaceDirectionListProjection,
  WorkspaceGraphFilter,
  WorkspaceGraphPreset,
  WorkspaceGraphProjection,
  WorkspaceGraphProjectionEdge,
  WorkspaceGraphProjectionNode,
  WorkspaceMatrixCell,
  WorkspaceMatrixMetric,
  WorkspaceMatrixProjection,
  WorkspaceProjectionContext,
  WorkspaceQuery,
  WorkspaceQueryResult,
  WorkspaceRankEntry,
  WorkspaceRankProjection,
  WorkspaceRankQuery,
  WorkspaceReviewEdgeProjection,
  WorkspaceReviewListProjection,
} from "./workspace-projection-types";

// V9.4 projection layer, part two: renderer-neutral graphs, the focused
// concept graph, sparse matrices, ranked lists on one explicit metric each,
// direction and review lists, and the typed query dispatcher. No
// coordinates, no styling, no combined score; a preset is a field
// selection over the same canonical edges.

// ---------------------------------------------------------------------------
// PACKAGE GRAPH

interface PresetSpec {
  dependency: boolean;
  edgeSource: string;
  review: boolean;
  roles: ConceptDirectionRole[];
  seamsOnly: boolean;
}

const ALL_ROLES: ConceptDirectionRole[] = [
  "implementation",
  "behavior",
  "representation",
  "usage",
  "conversion",
];

/** Every preset, spelled out: which canonical edges it keeps. */
export const GRAPH_PRESETS: Record<WorkspaceGraphPreset, PresetSpec> = {
  "architecture-overview": {
    dependency: true,
    edgeSource:
      "package dependency edges + every semantic direction + declared→gravity-center review directions",
    review: true,
    roles: ALL_ROLES,
    seamsOnly: false,
  },
  "architecture-review": {
    dependency: false,
    edgeSource: "declared package → gravity center review directions (V9.3)",
    review: true,
    roles: [],
    seamsOnly: false,
  },
  "behavior-flow": {
    dependency: false,
    edgeSource: "semantic→behavior directions (V9.2)",
    review: false,
    roles: ["behavior"],
    seamsOnly: false,
  },
  "conversion-flow": {
    dependency: false,
    edgeSource: "semantic→conversion directions (V9.2)",
    review: false,
    roles: ["conversion"],
    seamsOnly: false,
  },
  "dependency-topology": {
    dependency: true,
    edgeSource: "package dependency edges (V9.1 package graph)",
    review: false,
    roles: [],
    seamsOnly: false,
  },
  "implementation-flow": {
    dependency: false,
    edgeSource: "semantic→implementation directions (V9.2)",
    review: false,
    roles: ["implementation"],
    seamsOnly: false,
  },
  "representation-flow": {
    dependency: false,
    edgeSource: "semantic→representation directions (V9.2)",
    review: false,
    roles: ["representation"],
    seamsOnly: false,
  },
  "structural-seam": {
    dependency: true,
    edgeSource: "package dependency edges that are V9.1 seams",
    review: false,
    roles: [],
    seamsOnly: true,
  },
  "usage-flow": {
    dependency: false,
    edgeSource: "semantic→usage directions (V9.2)",
    review: false,
    roles: ["usage"],
    seamsOnly: false,
  },
};

function nodesOf(
  context: WorkspaceProjectionContext
): WorkspaceGraphProjectionNode[] {
  const { workspace, lookup } = context;
  return workspace.packages.packages
    .map((pkg): WorkspaceGraphProjectionNode => {
      const node = lookup.graphNodeById.get(pkg.id);
      const profile = lookup.profileById.get(pkg.id);
      const summary = lookup.roleSummaryById.get(pkg.id);
      const cautions: string[] = [];
      if (!pkg.analyzed) {
        cautions.push("package-not-analyzed");
      }
      if (node === undefined) {
        cautions.push("package-not-in-graph");
      }
      return {
        analyzed: pkg.analyzed,
        anchored: pkg.anchored,
        cautions,
        graphRole: node?.role ?? null,
        id: pkg.id,
        kind: "package",
        label: short(pkg.id),
        layer: node?.layer ?? null,
        metrics: {
          declaredConcepts: summary?.declaredConcepts ?? 0,
          fanIn: node?.direct.fanIn ?? 0,
          fanOut: node?.direct.fanOut ?? 0,
          participatingConcepts: summary?.participating.total ?? 0,
        },
        roles: (profile?.roles ?? []).map((r) => r.kind),
      };
    })
    .sort((a, b) => byId(a.id, b.id));
}

function dependencyEdges(
  context: WorkspaceProjectionContext,
  seamsOnly: boolean
): WorkspaceDependencyEdgeProjection[] {
  const { graph, lookup } = context;
  return graph.edges
    .filter((e) => !seamsOnly || lookup.seamIds.has(e.id))
    .map((e): WorkspaceDependencyEdgeProjection => {
      const load = lookup.loadByBoundary.get(e.id);
      return {
        concepts: {
          behavior: load?.roles.behavior ?? 0,
          conversion: load?.roles.conversion ?? 0,
          implementation: load?.roles.implementation ?? 0,
          representation: load?.roles.representation ?? 0,
          semanticUse: load?.roles.semanticUse ?? 0,
          total: load?.conceptCount ?? 0,
        },
        dependency: {
          importSites: e.weights.importSites,
          moduleEdges: e.weights.moduleEdges,
          references: e.weights.references,
        },
        from: e.from,
        id: e.id,
        kind: "dependency",
        patterns: lookup.boundaryPatternById.get(e.id)?.kinds ?? [],
        structure: {
          alternativeRoutes: e.alternativeRoutes,
          seam: lookup.seamIds.has(e.id),
          severedPairs: e.severedPairs,
          weakBridge: e.weakBridge,
        },
        to: e.to,
      };
    })
    .sort((a, b) => byId(a.id, b.id));
}

function directionEdges(
  context: WorkspaceProjectionContext,
  roles: ConceptDirectionRole[]
): WorkspaceDirectionEdgeProjection[] {
  const { concepts, lookup } = context;
  return concepts.directions
    .map(projectDirection)
    .filter((d) => roles.includes(d.role))
    .map(
      (d): WorkspaceDirectionEdgeProjection => ({
        concepts: { conceptIds: d.concepts, count: d.count },
        from: d.from,
        id: `direction:${d.id}`,
        kind: "direction",
        pairPatterns:
          lookup.pairPatternById.get(boundaryIdOf(d.from, d.to))?.patterns ??
          [],
        role: d.role,
        staticDependencyDirection: d.staticDependencyDirection,
        to: d.to,
      })
    )
    .sort((a, b) => byId(a.id, b.id));
}

function reviewEdges(
  context: WorkspaceProjectionContext
): WorkspaceReviewEdgeProjection[] {
  return context.patterns.reviewPatterns
    .filter((r) => r.scope === "direction")
    .map(
      (r): WorkspaceReviewEdgeProjection => ({
        from: r.entityIds[0] ?? "",
        id: `review:${r.id}`,
        kind: "review",
        reviews: projectReviewContext(r.reviews),
        to: r.entityIds[1] ?? "",
      })
    )
    .sort((a, b) => byId(a.id, b.id));
}

function conceptCountOf(edge: WorkspaceGraphProjectionEdge): number {
  switch (edge.kind) {
    case "dependency":
      return edge.concepts.total;
    case "direction":
      return edge.concepts.count;
    case "review":
      return edge.reviews.reviewed;
  }
}

export function projectWorkspaceGraph(
  context: WorkspaceProjectionContext,
  preset: WorkspaceGraphPreset,
  filter: WorkspaceGraphFilter = {}
): WorkspaceGraphProjection {
  const spec = GRAPH_PRESETS[preset];
  const keep = new Set(filter.packages);
  const kept = (id: string) => filter.packages === undefined || keep.has(id);
  const edges: WorkspaceGraphProjectionEdge[] = [
    ...(spec.dependency ? dependencyEdges(context, spec.seamsOnly) : []),
    ...(spec.roles.length > 0 ? directionEdges(context, spec.roles) : []),
    ...(spec.review ? reviewEdges(context) : []),
  ].filter(
    (e) =>
      kept(e.from) &&
      kept(e.to) &&
      (filter.minConcepts === undefined ||
        conceptCountOf(e) >= filter.minConcepts)
  );
  const touched = new Set(edges.flatMap((e) => [e.from, e.to]));
  const nodes = nodesOf(context).filter(
    (n) => kept(n.id) && (filter.connectedOnly !== true || touched.has(n.id))
  );
  const nodeIds = new Set(nodes.map((n) => n.id));
  const groups = [
    ...context.graph.layers.packageLayers.map((l) => ({
      id: `layer-${l.index}`,
      kind: "layer" as const,
      members: l.nodes.filter((n) => nodeIds.has(n)),
    })),
    ...context.graph.topology.packageComponents.map((c) => ({
      id: `component-${c.id}`,
      kind: "component" as const,
      members: c.nodes.filter((n) => nodeIds.has(n)),
    })),
  ].filter((g) => g.members.length > 0);
  return {
    edges,
    groups,
    metadata: {
      coverage: projectionCoverage(context),
      edgeSource: spec.edgeSource,
      filter,
      preset,
      scope: "workspace",
    },
    nodes,
  };
}

// ---------------------------------------------------------------------------
// CONCEPT GRAPH

const ROLE_EDGES: Record<WorkspaceConceptPackageRole, ConceptGraphEdgeKind> = {
  behaves: "behavior-in",
  converts: "converted-in",
  declares: "declared-in",
  implements: "implemented-in",
  represents: "represented-in",
  uses: "used-in",
};

export function projectConceptGraph(
  context: WorkspaceProjectionContext,
  conceptId: string
): WorkspaceConceptGraphProjection | undefined {
  const { lookup } = context;
  const placement = lookup.placementById.get(conceptId);
  if (placement === undefined) {
    return undefined;
  }
  const layers = new Map(
    placement.topology.packageLayers.map((l) => [l.package, l.layer])
  );
  const packages = sorted(placement.presence.packages);
  const nodes: ConceptGraphNode[] = [
    {
      focus: true,
      id: conceptId,
      kind: "concept",
      label: placement.concept.name,
      package: placement.concept.package,
    },
    ...packages.map(
      (pkg): ConceptGraphNode => ({
        focus: false,
        id: pkg,
        kind: "package",
        label: short(pkg),
        layer: layers.get(pkg) ?? null,
      })
    ),
  ];
  const edges: ConceptGraphEdge[] = [];
  for (const entry of placement.presence.roles) {
    for (const role of entry.roles) {
      const kind = ROLE_EDGES[role];
      edges.push({
        from: conceptId,
        id: `${conceptId}→${entry.package}:${kind}`,
        kind,
        to: entry.package,
      });
    }
  }
  const partners = [...placement.relationships.overlaps].sort((a, b) =>
    byId(a.other, b.other)
  );
  for (const rel of partners) {
    const other = lookup.conceptById.get(rel.other);
    if (!nodes.some((n) => n.id === rel.other)) {
      nodes.push({
        focus: false,
        id: rel.other,
        kind: "concept",
        label: other?.name ?? rel.other.split("#").pop() ?? rel.other,
        package: rel.otherPackage,
      });
    }
    edges.push({
      conversion: rel.conversions.length > 0,
      from: conceptId,
      id: `overlap:${rel.pair}`,
      kind: "overlap",
      shapes: rel.shapes,
      to: rel.other,
    });
  }
  const included = new Set(packages);
  for (const edge of placement.topology.edges) {
    if (!(included.has(edge.from) && included.has(edge.to))) {
      continue;
    }
    edges.push({
      from: edge.from,
      id: `dependency:${edge.id}`,
      importSites: edge.volume.importSites,
      kind: "dependency",
      moduleEdges: edge.volume.moduleEdges,
      to: edge.to,
    });
  }
  return {
    concept: conceptId,
    edges: edges.sort((a, b) => byId(a.id, b.id)),
    metadata: { coverage: projectionCoverage(context), scope: "concept" },
    nodes,
  };
}

// ---------------------------------------------------------------------------
// MATRICES

function axis(
  ids: string[],
  kind: ProjectionAxisEntity["kind"]
): ProjectionAxisEntity[] {
  return sorted(ids).map((id) => ({
    id,
    kind,
    label: kind === "package" || kind === "boundary" ? short(id) : id,
  }));
}

const ROLE_COLUMNS = [
  "declared",
  "semanticCenters",
  "implementationCenters",
  "behaviorCenters",
  "representationCenters",
  "usageCenters",
  "implementing",
  "behaving",
  "representing",
  "using",
  "converting",
] as const;

function matrixOf(
  context: WorkspaceProjectionContext,
  metric: WorkspaceMatrixMetric
): Pick<
  WorkspaceMatrixProjection,
  "rows" | "columns" | "cells" | "metricLabel"
> {
  const { concepts, lookup, workspace } = context;
  switch (metric.kind) {
    case "package-concept-roles": {
      const rows = concepts.packageRoles.filter(
        (r) => r.declaredConcepts > 0 || r.participating.total > 0
      );
      const cells: WorkspaceMatrixCell[] = [];
      for (const row of rows) {
        const values: Record<(typeof ROLE_COLUMNS)[number], number> = {
          behaving: row.participating.behaving,
          behaviorCenters: row.behaviorCenters,
          converting: row.participating.converting,
          declared: row.declaredConcepts,
          implementationCenters: row.implementationCenters,
          implementing: row.participating.implementing,
          representationCenters: row.representationCenters,
          representing: row.participating.representing,
          semanticCenters: row.semanticCenters,
          usageCenters: row.usageCenters,
          using: row.participating.using,
        };
        for (const column of ROLE_COLUMNS) {
          if (values[column] > 0) {
            cells.push({ column, row: row.package, value: values[column] });
          }
        }
      }
      return {
        cells,
        columns: ROLE_COLUMNS.map((c) => ({ id: c, kind: "role", label: c })),
        metricLabel: "distinct concepts per package and role",
        rows: axis(
          rows.map((r) => r.package),
          "package"
        ),
      };
    }
    case "package-direction": {
      const directions = concepts.directions
        .map(projectDirection)
        .filter((d) => d.role === metric.metric);
      return {
        cells: directions.map((d) => ({
          column: d.to,
          entityIds: d.concepts,
          row: d.from,
          value: d.count,
        })),
        columns: axis(
          directions.map((d) => d.to),
          "package"
        ),
        metricLabel: `concepts declared in row and ${metric.metric === "usage" ? "used" : metric.metric === "behavior" ? "behaved" : metric.metric === "conversion" ? "converted" : metric.metric === "representation" ? "represented" : "implemented"} in column`,
        rows: axis(
          directions.map((d) => d.from),
          "package"
        ),
      };
    }
    case "boundary-concept-load": {
      const boundaries = workspace.boundaries.boundaries;
      const value = (id: string): { value: number; entityIds?: string[] } => {
        const boundary = lookup.boundaryById.get(id);
        const load = lookup.loadByBoundary.get(id);
        const edge = lookup.edgeById.get(id);
        switch (metric.metric) {
          case "concepts":
            return {
              entityIds: load?.concepts ?? [],
              value: load?.conceptCount ?? 0,
            };
          case "importSites":
            return { value: boundary?.importSites ?? 0 };
          case "moduleEdges":
            return { value: boundary?.moduleEdges ?? 0 };
          case "severedPairs":
            return { value: edge?.severedPairs ?? 0 };
          case "behavior":
            return { value: load?.roles.behavior ?? 0 };
          case "implementation":
            return { value: load?.roles.implementation ?? 0 };
          case "representation":
            return { value: load?.roles.representation ?? 0 };
          case "semanticUse":
            return { value: load?.roles.semanticUse ?? 0 };
          case "conversion":
            return { value: load?.roles.conversion ?? 0 };
        }
      };
      const cells = boundaries
        .map((b) => ({ column: b.to, row: b.from, ...value(b.id) }))
        .filter((c) => c.value > 0);
      return {
        cells,
        columns: axis(
          boundaries.map((b) => b.to),
          "package"
        ),
        metricLabel: `${metric.metric} on the row→column boundary`,
        rows: axis(
          boundaries.map((b) => b.from),
          "package"
        ),
      };
    }
    case "review": {
      const reviews = projectAllReviews(context);
      const cellsById = new Map<string, WorkspaceMatrixCell>();
      for (const review of reviews) {
        const column = review.gravityCenter ?? "(no gravity center)";
        const counted = (() => {
          switch (metric.metric) {
            case "reviewed":
              return true;
            case "credibleAlternatives":
              return review.disposition === "credible-alternative";
            case "dominatedBaselines":
              return review.baselineDominated;
            case "preserveCurrent":
              return review.disposition === "preserve-current";
            case "insufficientEvidence":
              return review.disposition === "insufficient-evidence";
          }
        })();
        if (!counted) {
          continue;
        }
        const key = `${review.declaredPackage}|${column}`;
        const cell = cellsById.get(key) ?? {
          column,
          entityIds: [],
          row: review.declaredPackage,
          value: 0,
        };
        cell.value += 1;
        cell.entityIds = sorted([...(cell.entityIds ?? []), review.conceptId]);
        cellsById.set(key, cell);
      }
      const cells = [...cellsById.values()];
      return {
        cells,
        columns: axis(
          cells.map((c) => c.column),
          "package"
        ),
        metricLabel: `${metric.metric} reviews: declared package (row) vs gravity center (column)`,
        rows: axis(
          cells.map((c) => c.row),
          "package"
        ),
      };
    }
  }
}

export function projectWorkspaceMatrix(
  context: WorkspaceProjectionContext,
  metric: WorkspaceMatrixMetric
): WorkspaceMatrixProjection {
  const built = matrixOf(context, metric);
  const id =
    metric.kind === "package-concept-roles"
      ? metric.kind
      : `${metric.kind}:${metric.metric}`;
  return {
    id,
    metric,
    ...built,
    cells: built.cells.sort(
      (a, b) => byId(a.row, b.row) || byId(a.column, b.column)
    ),
    coverage: projectionCoverage(context),
  };
}

// ---------------------------------------------------------------------------
// RANKED LISTS

function rankEntries(
  context: WorkspaceProjectionContext,
  query: WorkspaceRankQuery
): WorkspaceRankEntry[] {
  const { concepts, lookup, workspace } = context;
  switch (query.kind) {
    case "packages":
      return workspace.packages.packages.map((pkg) => {
        const summary = lookup.roleSummaryById.get(pkg.id);
        const profile = lookup.profileById.get(pkg.id);
        const node = lookup.graphNodeById.get(pkg.id);
        const values: Record<typeof query.metric, number> = {
          behaviorCenters: summary?.behaviorCenters ?? 0,
          declaredConcepts: summary?.declaredConcepts ?? 0,
          dependencyReach: node?.transitive.dependencies ?? 0,
          dependentReach: node?.transitive.dependents ?? 0,
          fanIn: node?.direct.fanIn ?? 0,
          fanOut: node?.direct.fanOut ?? 0,
          foreignImplemented: profile?.counts.foreignImplemented ?? 0,
          foreignUsed: profile?.counts.foreignUsed ?? 0,
          implementationCenters: summary?.implementationCenters ?? 0,
          representationCenters: summary?.representationCenters ?? 0,
          roleCount: profile?.roles.length ?? 0,
          semanticCenters: summary?.semanticCenters ?? 0,
          usageCenters: summary?.usageCenters ?? 0,
        };
        return {
          id: pkg.id,
          kind: "package",
          label: short(pkg.id),
          value: values[query.metric],
        };
      });
    case "boundaries":
      return workspace.boundaries.boundaries.map((b) => {
        const load = lookup.loadByBoundary.get(b.id);
        const edge = lookup.edgeById.get(b.id);
        const conceptCount = load?.conceptCount ?? 0;
        const values: Record<typeof query.metric, number> = {
          behaviorConcepts: load?.roles.behavior ?? 0,
          concepts: conceptCount,
          conceptsPerImportSite:
            b.importSites > 0 ? conceptCount / b.importSites : 0,
          implementationConcepts: load?.roles.implementation ?? 0,
          importSites: b.importSites,
          moduleEdges: b.moduleEdges,
          severedPairs: edge?.severedPairs ?? 0,
        };
        return {
          id: b.id,
          kind: "boundary",
          label: `${short(b.from)}→${short(b.to)}`,
          value: values[query.metric],
          ...(query.metric === "conceptsPerImportSite" && {
            denominator: b.importSites,
            numerator: conceptCount,
          }),
        };
      });
    case "concepts":
      return concepts.concepts.map((p) => {
        const values: Record<typeof query.metric, number> = {
          behaviorLayerSpan: p.span.behaviorLayerSpan ?? 0,
          boundaries: p.span.boundaryCount,
          crossPackageCouplings: p.evolution?.crossPackageCouplings ?? 0,
          implementationPackages: p.extent.implementationPackages,
          packages: p.presence.packages.length,
          referencePackages: p.extent.referencePackages,
          responsibilityLayerSpan: p.span.responsibilityLayerSpan ?? 0,
        };
        return {
          id: p.concept.id,
          kind: "concept",
          label: `${p.concept.name} (${short(p.concept.package)})`,
          value: values[query.metric],
        };
      });
  }
}

export function rankWorkspace(
  context: WorkspaceProjectionContext,
  query: WorkspaceRankQuery
): WorkspaceRankProjection {
  const entries = rankEntries(context, query)
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value || byId(a.id, b.id));
  return {
    coverage: projectionCoverage(context),
    entries:
      query.limit === undefined ? entries : entries.slice(0, query.limit),
    query,
    sort: "value desc, id asc",
    total: entries.length,
  };
}

// ---------------------------------------------------------------------------
// LISTS

export function listConceptDirections(
  context: WorkspaceProjectionContext,
  filter: ConceptDirectionFilter = {}
): WorkspaceDirectionListProjection {
  return {
    directions: context.concepts.directions
      .map(projectDirection)
      .filter(
        (d) =>
          (filter.from === undefined || d.from === filter.from) &&
          (filter.to === undefined || d.to === filter.to) &&
          (filter.role === undefined || d.role === filter.role) &&
          (filter.minCount === undefined || d.count >= filter.minCount)
      )
      .sort(byCountThenId),
    filter,
    sort: "count desc, id asc",
  };
}

export function listWorkspaceReviews(
  context: WorkspaceProjectionContext,
  filter: ReviewListFilter = {}
): WorkspaceReviewListProjection {
  return {
    filter,
    reviews: projectAllReviews(context).filter(
      (r) =>
        (filter.disposition === undefined ||
          r.disposition === filter.disposition) &&
        (filter.baselineDominated === undefined ||
          r.baselineDominated === filter.baselineDominated) &&
        (filter.declaredPackage === undefined ||
          r.declaredPackage === filter.declaredPackage) &&
        (filter.gravityCenter === undefined ||
          r.gravityCenter === filter.gravityCenter)
    ),
    sort: "conceptId asc",
  };
}

// ---------------------------------------------------------------------------
// QUERY DISPATCH

/**
 * One typed entry point over the projection functions. Entity queries take
 * an id or a name; a name matching several entities returns them all.
 */
export function queryWorkspace(
  context: WorkspaceProjectionContext,
  query: WorkspaceQuery
): WorkspaceQueryResult {
  const resolve = (
    text: string,
    kind: "package" | "concept" | "boundary" | "pattern" | "review"
  ): string | WorkspaceQueryResult => {
    const resolution = resolveWorkspaceEntity(context, text, kind);
    if (resolution.status === "resolved") {
      return resolution.entity.id;
    }
    if (resolution.status === "ambiguous") {
      return { candidates: resolution.candidates, kind: "ambiguous", query };
    }
    return { kind: "not-found", query };
  };
  switch (query.kind) {
    case "overview":
      return { kind: "overview", result: projectWorkspaceOverview(context) };
    case "package": {
      const id = resolve(query.id, "package");
      if (typeof id !== "string") {
        return id;
      }
      const result = projectWorkspacePackage(context, id, query.detail);
      if (result === undefined) {
        return { kind: "not-found", query };
      }
      return query.detail === "summary"
        ? { kind: "package-summary", result: summarizeWorkspacePackage(result) }
        : { kind: "package", result };
    }
    case "concept": {
      const id = resolve(query.id, "concept");
      if (typeof id !== "string") {
        return id;
      }
      const result = projectWorkspaceConcept(context, id, query.detail);
      if (result === undefined) {
        return { kind: "not-found", query };
      }
      return query.detail === "summary"
        ? { kind: "concept-summary", result: summarizeWorkspaceConcept(result) }
        : { kind: "concept", result };
    }
    case "boundary": {
      const id = resolve(query.id, "boundary");
      if (typeof id !== "string") {
        return id;
      }
      const result = projectWorkspaceBoundary(context, id, query.detail);
      return result === undefined
        ? { kind: "not-found", query }
        : { kind: "boundary", result };
    }
    case "pattern": {
      const id = resolve(query.id, "pattern");
      if (typeof id !== "string") {
        return id;
      }
      const result = projectWorkspacePattern(context, id, query.detail);
      return result === undefined
        ? { kind: "not-found", query }
        : { kind: "pattern", result };
    }
    case "review": {
      const id = resolve(query.conceptId, "concept");
      if (typeof id !== "string") {
        return id;
      }
      const result = projectWorkspaceReview(context, id);
      return result === undefined
        ? { kind: "not-found", query }
        : { kind: "review", result };
    }
    case "graph":
      return {
        kind: "graph",
        result: projectWorkspaceGraph(context, query.preset, query.filter),
      };
    case "concept-graph": {
      const id = resolve(query.conceptId, "concept");
      if (typeof id !== "string") {
        return id;
      }
      const result = projectConceptGraph(context, id);
      return result === undefined
        ? { kind: "not-found", query }
        : { kind: "concept-graph", result };
    }
    case "matrix":
      return {
        kind: "matrix",
        result: projectWorkspaceMatrix(context, query.metric),
      };
    case "rank":
      return { kind: "rank", result: rankWorkspace(context, query.rank) };
    case "directions":
      return {
        kind: "directions",
        result: listConceptDirections(context, query.filter),
      };
    case "reviews":
      return {
        kind: "reviews",
        result: listWorkspaceReviews(context, query.filter),
      };
    case "search":
      return {
        kind: "search",
        result: searchWorkspace(context, query.text, {
          ...(query.mode !== undefined && { mode: query.mode }),
          ...(query.kinds !== undefined && { kinds: query.kinds }),
        }),
      };
  }
}
