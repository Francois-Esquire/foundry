import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type { ArchitecturalReviewDisposition } from "./types";
import type {
  ConceptEdgeRole,
  WorkspaceBoundaryConceptLoad,
  WorkspaceConceptCaution,
  WorkspaceConceptCenters,
  WorkspaceConceptCoupling,
  WorkspaceConceptCoverage,
  WorkspaceConceptDirection,
  WorkspaceConceptDirectionKind,
  WorkspaceConceptEdge,
  WorkspaceConceptEvolutionContext,
  WorkspaceConceptFamilyTopology,
  WorkspaceConceptFlow,
  WorkspaceConceptIntelligence,
  WorkspaceConceptIntelligenceCaution,
  WorkspaceConceptPackageRole,
  WorkspaceConceptPairTopology,
  WorkspaceConceptPath,
  WorkspaceConceptPlacement,
  WorkspaceConceptPresence,
  WorkspaceConceptPropagation,
  WorkspaceConceptRelationship,
  WorkspaceConceptShape,
  WorkspaceConceptSpan,
  WorkspaceConceptSpanDistribution,
  WorkspaceConceptTopology,
  WorkspaceContractFamilyCategory,
  WorkspacePackageConceptRoleSummary,
} from "./workspace-concepts-types";
import type {
  WorkspaceGraphAnalysis,
  WorkspacePackageGraphAnalysis,
  WorkspacePackageGraphEdge,
} from "./workspace-graph-types";
import type {
  WorkspaceConcept,
  WorkspaceConceptOverlap,
  WorkspaceCouplingPair,
  WorkspaceReport,
} from "./workspace-types";

// V9.2: canonical concepts placed on the V9.1 package graph. Reads only
// the WorkspaceReport and its attached graph analysis; never the package
// reports, never source files. Per concept the work is bounded by its own
// presence packages; every graph lookup is a memoized table built once.

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(byId);
}

function pairId(a: string, b: string): string {
  return [a, b].sort(byId).join("|");
}

/** Static package-graph lookups, built once for every concept to share. */
interface GraphIndex {
  chains: string[][];
  /** from → (to → shortest distance in edges). */
  distance: Map<string, Map<string, number>>;
  edges: Map<string, WorkspacePackageGraphEdge>;
  nodes: Map<string, WorkspacePackageGraphAnalysis>;
  seams: Set<string>;
  usageOnly: Set<string>;
}

function indexGraph(graph: WorkspaceGraphAnalysis): GraphIndex {
  const adjacency = new Map<string, string[]>();
  for (const node of graph.packages) {
    adjacency.set(node.package, []);
  }
  for (const edge of graph.edges) {
    adjacency.get(edge.from)?.push(edge.to);
  }
  const distance = new Map<string, Map<string, number>>();
  for (const start of adjacency.keys()) {
    const seen = new Map<string, number>([[start, 0]]);
    const queue = [start];
    // The array iterator sees nodes pushed during the walk, so this is a BFS.
    for (const node of queue) {
      const d = seen.get(node) ?? 0;
      for (const next of adjacency.get(node) ?? []) {
        if (seen.has(next)) {
          continue;
        }
        seen.set(next, d + 1);
        queue.push(next);
      }
    }
    seen.delete(start);
    distance.set(start, seen);
  }
  return {
    chains: graph.reachability.longestPackageChains,
    distance,
    edges: new Map(graph.edges.map((e) => [e.id, e])),
    nodes: new Map(graph.packages.map((p) => [p.package, p])),
    seams: new Set(graph.seams.map((s) => s.id)),
    usageOnly: new Set(graph.topology.usageOnlyEdges),
  };
}

function hops(index: GraphIndex, from: string, to: string): number | null {
  return index.distance.get(from)?.get(to) ?? null;
}

function joinedByUsageOnly(index: GraphIndex, a: string, b: string): boolean {
  return index.usageOnly.has(`${a}→${b}`) || index.usageOnly.has(`${b}→${a}`);
}

/** `pkg` relative to `center`: forward means `pkg` imports its way to `center`. */
function pathTo(
  index: GraphIndex,
  pkg: string,
  center: string
): WorkspaceConceptPath {
  const usageOnly = joinedByUsageOnly(index, pkg, center);
  if (!(index.nodes.has(pkg) && index.nodes.has(center))) {
    return { distance: null, package: pkg, relation: "unmeasured", usageOnly };
  }
  const forward = hops(index, pkg, center);
  if (forward !== null) {
    return {
      distance: forward,
      package: pkg,
      relation: forward === 1 ? "direct" : "indirect",
      usageOnly,
    };
  }
  const reverse = hops(index, center, pkg);
  if (reverse !== null) {
    return {
      distance: reverse,
      package: pkg,
      relation: "reverse-directed",
      usageOnly,
    };
  }
  return { distance: null, package: pkg, relation: "disconnected", usageOnly };
}

const EDGE_ROLE: Partial<Record<WorkspaceConceptPackageRole, ConceptEdgeRole>> =
  {
    behaves: "behavior",
    converts: "conversion",
    implements: "implementation",
    represents: "representation",
    uses: "semantic-use",
  };

const EDGE_ROLE_ORDER: ConceptEdgeRole[] = [
  "semantic-use",
  "behavior",
  "implementation",
  "representation",
  "conversion",
];

/** Module id → package, from the canonical module index, else the package path prefix. */
function modulePackageResolver(
  workspace: WorkspaceReport
): (module: string) => string | null {
  const byModule = new Map<string, string>();
  for (const module of workspace.graph.modules) {
    if (module.package !== undefined) {
      byModule.set(module.id, module.package);
    }
  }
  for (const churn of workspace.evolution.churn) {
    if (churn.package !== undefined && !byModule.has(churn.file)) {
      byModule.set(churn.file, churn.package);
    }
  }
  const paths = workspace.packages.packages
    .flatMap((p) => (p.path === undefined ? [] : [{ id: p.id, path: p.path }]))
    .sort((a, b) => b.path.length - a.path.length);
  return (module) => {
    const known = byModule.get(module);
    if (known !== undefined) {
      return known;
    }
    return paths.find((p) => module.startsWith(`${p.path}/`))?.id ?? null;
  };
}

interface RoleTable {
  /** Source behavior that only names the concept in a signature: consumers, not a role. */
  contractOnly: Set<string>;
  converterPackages: Set<string>;
  roles: Map<string, Set<WorkspaceConceptPackageRole>>;
}

function rolesOf(
  concept: WorkspaceConcept,
  overlaps: Map<string, WorkspaceConceptOverlap>,
  packageOf: (module: string) => string | null
): RoleTable {
  const roles = new Map<string, Set<WorkspaceConceptPackageRole>>();
  const add = (pkg: string, role?: WorkspaceConceptPackageRole) => {
    const set = roles.get(pkg) ?? new Set<WorkspaceConceptPackageRole>();
    if (role !== undefined) {
      set.add(role);
    }
    roles.set(pkg, set);
  };
  add(concept.package, "declares");
  for (const pkg of concept.distribution?.packages ?? []) {
    add(pkg);
  }
  for (const p of concept.representations?.byPackage ?? []) {
    if (p.representations > 0) {
      add(p.package, "represents");
    }
  }
  for (const p of concept.ownership?.participation ?? []) {
    if (p.representations > 0) {
      add(p.package, "represents");
    }
    if (p.implementations > 0) {
      add(p.package, "implements");
    }
    if (p.references > 0) {
      add(p.package, "uses");
    }
    if (p.conversions > 0) {
      add(p.package, "converts");
    }
  }
  const contractOnly = new Set<string>();
  for (const p of concept.locality?.behavior ?? []) {
    if (p.implementationBehaviors > 0 || p.conversionBehaviors > 0) {
      add(p.package, "behaves");
    } else if (p.sourceBehaviors > 0) {
      contractOnly.add(p.package);
      add(p.package);
    }
  }
  const converterPackages = new Set<string>();
  for (const id of concept.overlaps) {
    for (const conversion of overlaps.get(id)?.conversions ?? []) {
      const pkg = packageOf(conversion.file);
      if (pkg === null) {
        continue;
      }
      converterPackages.add(pkg);
      add(pkg, "converts");
    }
  }
  return { contractOnly, converterPackages, roles };
}

function withRole(
  table: RoleTable,
  role: WorkspaceConceptPackageRole
): string[] {
  return sorted(
    [...table.roles].flatMap(([pkg, set]) => (set.has(role) ? [pkg] : []))
  );
}

const ROLE_ORDER: WorkspaceConceptPackageRole[] = [
  "declares",
  "implements",
  "represents",
  "uses",
  "behaves",
  "converts",
];

function presenceOf(
  concept: WorkspaceConcept,
  table: RoleTable
): WorkspaceConceptPresence {
  return {
    behaviorPackages: withRole(table, "behaves"),
    contractBehaviorPackages: sorted(table.contractOnly),
    converterPackages: withRole(table, "converts"),
    declaredPackage: concept.package,
    implementationPackages: withRole(table, "implements"),
    packages: sorted(table.roles.keys()),
    referencePackages: withRole(table, "uses"),
    representationPackages: withRole(table, "represents"),
    roles: sorted(table.roles.keys()).map((pkg) => ({
      package: pkg,
      roles: ROLE_ORDER.filter((role) => table.roles.get(pkg)?.has(role)),
    })),
  };
}

function layerOf(index: GraphIndex, pkg: string): number | null {
  return index.nodes.get(pkg)?.layer ?? null;
}

function layerSpan(index: GraphIndex, packages: string[]): number | null {
  const layers = packages.flatMap((pkg) => {
    const layer = layerOf(index, pkg);
    return layer === null ? [] : [layer];
  });
  if (layers.length === 0) {
    return null;
  }
  return Math.max(...layers) - Math.min(...layers);
}

function conceptEdges(
  index: GraphIndex,
  presence: WorkspaceConceptPresence,
  table: RoleTable
): WorkspaceConceptEdge[] {
  const edges: WorkspaceConceptEdge[] = [];
  for (const from of presence.packages) {
    const roles = EDGE_ROLE_ORDER.filter((role) =>
      [...(table.roles.get(from) ?? [])].some((r) => EDGE_ROLE[r] === role)
    );
    if (roles.length === 0) {
      continue;
    }
    for (const to of presence.packages) {
      if (from === to) {
        continue;
      }
      const edge = index.edges.get(`${from}→${to}`);
      if (edge === undefined) {
        continue;
      }
      edges.push({
        evidence: [
          { entities: [from], kind: "package-role", value: roles.join(",") },
          { entities: [edge.id], kind: "dependency-edge" },
          {
            entities: [edge.id],
            kind: "boundary",
            value: edge.weights.moduleEdges,
          },
        ],
        from,
        fromDeclared: from === presence.declaredPackage,
        id: edge.id,
        roles,
        structure: {
          alternativeRoutes: edge.alternativeRoutes,
          seam: index.seams.has(edge.id),
          severedPairs: edge.severedPairs,
          weakBridge: edge.weakBridge,
        },
        to,
        toDeclared: to === presence.declaredPackage,
        volume: {
          distinctSymbols: edge.weights.distinctSymbols,
          importSites: edge.weights.importSites,
          moduleEdges: edge.weights.moduleEdges,
          references: edge.weights.references,
        },
      });
    }
  }
  return edges.sort((a, b) => byId(a.id, b.id));
}

function topologyOf(
  index: GraphIndex,
  presence: WorkspaceConceptPresence,
  edges: WorkspaceConceptEdge[]
): WorkspaceConceptTopology {
  const participating = presence.packages.filter((pkg) => index.nodes.has(pkg));
  const center = presence.declaredPackage;
  const paths = participating
    .filter((pkg) => pkg !== center)
    .map((pkg) => pathTo(index, pkg, center));
  const participatingSet = new Set(participating);
  return {
    components: sorted(
      participating.flatMap((pkg) => {
        const node = index.nodes.get(pkg);
        return node === undefined ? [] : [node.component];
      })
    ),
    disconnectedPackages: paths
      .filter((p) => p.relation === "disconnected")
      .map((p) => p.package),
    edges,
    longestChains: index.chains.filter(
      (chain) => chain.filter((pkg) => participatingSet.has(pkg)).length >= 2
    ),
    packageLayers: presence.packages.map((pkg) => ({
      layer: layerOf(index, pkg),
      package: pkg,
    })),
    participatingPackages: participating,
    paths,
    unknownPackages: presence.packages.filter((pkg) => !index.nodes.has(pkg)),
    usageOnlyEdges: [...index.usageOnly]
      .filter((id) => {
        const [from, to] = id.split("→");
        return (
          from !== undefined &&
          to !== undefined &&
          participatingSet.has(from) &&
          participatingSet.has(to)
        );
      })
      .sort(byId),
  };
}

function spanOf(
  index: GraphIndex,
  presence: WorkspaceConceptPresence,
  topology: WorkspaceConceptTopology
): WorkspaceConceptSpan {
  const declared = [presence.declaredPackage];
  const layers = topology.packageLayers.flatMap((p) =>
    p.layer === null ? [] : [p.layer]
  );
  const minLayer = layers.length === 0 ? null : Math.min(...layers);
  const maxLayer = layers.length === 0 ? null : Math.max(...layers);
  return {
    behaviorBoundaryCount: topology.edges.filter((e) =>
      e.roles.includes("behavior")
    ).length,
    behaviorLayerSpan: layerSpan(index, [
      ...declared,
      ...presence.behaviorPackages,
    ]),
    boundaryCount: topology.edges.length,
    disconnectedRegions: topology.components.length,
    implementationBoundaryCount: topology.edges.filter((e) =>
      e.roles.includes("implementation")
    ).length,
    implementationLayerSpan: layerSpan(index, [
      ...declared,
      ...presence.implementationPackages,
    ]),
    layerSpan:
      minLayer === null || maxLayer === null ? null : maxLayer - minLayer,
    layers: new Set(layers).size,
    maxLayer,
    minLayer,
    packages: presence.packages.length,
    representationLayerSpan: layerSpan(index, [
      ...declared,
      ...presence.representationPackages,
    ]),
    responsibilityLayerSpan: layerSpan(index, [
      ...declared,
      ...presence.behaviorPackages,
      ...presence.implementationPackages,
    ]),
    usageLayerSpan: layerSpan(index, [
      ...declared,
      ...presence.referencePackages,
    ]),
  };
}

function flowOf(
  presence: WorkspaceConceptPresence,
  topology: WorkspaceConceptTopology
): WorkspaceConceptFlow {
  const paths = new Map(topology.paths.map((p) => [p.package, p]));
  const pick = (packages: string[]) =>
    packages.flatMap((pkg) => {
      if (pkg === presence.declaredPackage) {
        return [];
      }
      const path = paths.get(pkg);
      return path === undefined
        ? [
            {
              distance: null,
              package: pkg,
              relation: "unmeasured" as const,
              usageOnly: false,
            },
          ]
        : [path];
    });
  return {
    semanticToBehavior: pick(presence.behaviorPackages),
    semanticToConversions: pick(presence.converterPackages),
    semanticToImplementations: pick(presence.implementationPackages),
    semanticToRepresentations: pick(presence.representationPackages),
    semanticToUsage: pick(presence.referencePackages),
  };
}

function propagationOf(
  index: GraphIndex,
  presence: WorkspaceConceptPresence,
  topology: WorkspaceConceptTopology
): WorkspaceConceptPropagation {
  const centerLayer = layerOf(index, presence.declaredPackage);
  if (centerLayer === null) {
    return "unmeasured";
  }
  const rolePackages = new Set([
    ...presence.behaviorPackages,
    ...presence.implementationPackages,
    ...presence.representationPackages,
    ...presence.referencePackages,
    ...presence.converterPackages,
  ]);
  rolePackages.delete(presence.declaredPackage);
  if (rolePackages.size === 0) {
    return "same-layer";
  }
  let above = false;
  let below = false;
  let connected = false;
  for (const path of topology.paths) {
    if (!rolePackages.has(path.package)) {
      continue;
    }
    if (path.relation === "disconnected" || path.relation === "unmeasured") {
      continue;
    }
    connected = true;
    const layer = layerOf(index, path.package);
    if (layer === null) {
      continue;
    }
    if (layer > centerLayer) {
      above = true;
    }
    if (layer < centerLayer) {
      below = true;
    }
  }
  if (!connected) {
    return "disconnected";
  }
  if (above && below) {
    return "bidirectional";
  }
  if (above) {
    return "upstream";
  }
  if (below) {
    return "downstream";
  }
  return "same-layer";
}

function shapesOf(
  presence: WorkspaceConceptPresence,
  topology: WorkspaceConceptTopology,
  span: WorkspaceConceptSpan,
  flow: WorkspaceConceptFlow,
  relationships: WorkspaceConceptRelationship[],
  certainty: WorkspaceGraphAnalysis["certainty"],
  config: AnalysisConfig
): WorkspaceConceptShape[] {
  const shapes: WorkspaceConceptShape[] = [];
  const forward = (p: WorkspaceConceptPath) =>
    p.relation === "direct" || p.relation === "indirect";
  if (presence.packages.length === 1) {
    shapes.push("local");
  }
  if (flow.semanticToImplementations.some(forward)) {
    shapes.push("downstream-implemented");
  }
  if (flow.semanticToUsage.some(forward)) {
    shapes.push("upstream-consumed");
  }
  if (
    span.responsibilityLayerSpan !== null &&
    span.responsibilityLayerSpan >=
      config.workspaceConcepts.shapes.crossLayer.minLayerSpan
  ) {
    shapes.push("cross-layer");
  }
  if (presence.implementationPackages.length >= 2) {
    shapes.push("parallel-implementation");
  }
  if (relationships.some((r) => r.crossPackage && r.conversions.length > 0)) {
    shapes.push("representation-split");
  }
  if (certainty === "complete" && topology.components.length >= 2) {
    shapes.push("multi-region");
  }
  return shapes;
}

function centersOf(
  index: GraphIndex,
  concept: WorkspaceConcept
): WorkspaceConceptCenters | undefined {
  const center = concept.ownership?.center;
  if (center === undefined) {
    return undefined;
  }
  const layer = (pkg: string | undefined) =>
    pkg === undefined ? undefined : (layerOf(index, pkg) ?? undefined);
  const reach = (pkg: string | undefined) => {
    const node = pkg === undefined ? undefined : index.nodes.get(pkg);
    return node === undefined ? undefined : { ...node.transitive };
  };
  const semanticLayer = layer(center.semantic);
  const representationLayer = layer(center.representation);
  const usageLayer = layer(center.usage);
  const behaviorLayer = layer(center.behavior);
  const semanticReach = reach(center.semantic);
  const representationReach = reach(center.representation);
  return {
    ...(center.semantic !== undefined && { semantic: center.semantic }),
    ...(center.representation !== undefined && {
      representation: center.representation,
    }),
    ...(center.usage !== undefined && { usage: center.usage }),
    ...(center.behavior !== undefined && { behavior: center.behavior }),
    ...(center.evolution !== undefined && { evolution: center.evolution }),
    graphContext: {
      ...(semanticLayer !== undefined && { semanticLayer }),
      ...(representationLayer !== undefined && { representationLayer }),
      ...(usageLayer !== undefined && { usageLayer }),
      ...(behaviorLayer !== undefined && { behaviorLayer }),
      ...(semanticReach !== undefined && { semanticReach }),
      ...(representationReach !== undefined && { representationReach }),
    },
    implementations: [...center.implementations].sort(byId),
  };
}

function relationshipsOf(
  concept: WorkspaceConcept,
  overlaps: Map<string, WorkspaceConceptOverlap>,
  packageOf: (module: string) => string | null
): WorkspaceConceptRelationship[] {
  return concept.overlaps.flatMap((id) => {
    const pair = overlaps.get(id);
    if (pair === undefined) {
      return [];
    }
    const other = pair.left.id === concept.id ? pair.right : pair.left;
    return [
      {
        bidirectionalConversion: pair.bidirectionalConversion,
        conversions: pair.conversions.map((c) => ({
          direction: c.from === concept.id ? "outgoing" : "incoming",
          file: c.file,
          function: c.function,
          package: packageOf(c.file),
        })),
        crossPackage: pair.crossPackage,
        other: other.id,
        otherPackage: other.package,
        pair: id,
        shapes: pair.shapes,
      },
    ];
  });
}

function couplingOf(
  index: GraphIndex,
  pair: WorkspaceCouplingPair
): WorkspaceConceptCoupling {
  return {
    coChangeCommits: pair.coChangeCommits,
    context: pair.context,
    dependencyPath: {
      forward: hops(index, pair.leftPackage, pair.rightPackage),
      reverse: hops(index, pair.rightPackage, pair.leftPackage),
    },
    id: pair.id,
    jaccard: pair.jaccard,
    left: pair.left,
    leftPackage: pair.leftPackage,
    right: pair.right,
    rightPackage: pair.rightPackage,
    scope: pair.scope,
    staticPath: pair.staticPath,
  };
}

function evolutionOf(
  index: GraphIndex,
  concept: WorkspaceConcept,
  couplings: Map<string, WorkspaceCouplingPair>,
  packageOf: (module: string) => string | null
): WorkspaceConceptEvolutionContext | undefined {
  const evolution = concept.evolution;
  if (evolution === undefined) {
    return undefined;
  }
  const pairs = evolution.couplings.flatMap((id) => {
    const pair = couplings.get(id);
    return pair === undefined ? [] : [couplingOf(index, pair)];
  });
  const strong = pairs.filter((p) => p.context === "source-source");
  const contextual = pairs.filter((p) => p.context !== "source-source");
  const hotspotPackages = sorted(
    evolution.hotspotModules.flatMap((module) => {
      const pkg = packageOf(module);
      return pkg === null ? [] : [pkg];
    })
  );
  return {
    contextualCouplings: contextual,
    crossPackageCouplings: strong.filter((p) => p.scope === "cross-package")
      .length,
    historicallyActivePackages: sorted([
      ...hotspotPackages,
      ...strong.flatMap((p) => [p.leftPackage, p.rightPackage]),
    ]),
    hotspotPackages,
    strongMemberCouplings: strong,
  };
}

function coverageOf(concept: WorkspaceConcept): WorkspaceConceptCoverage {
  if (concept.analysis !== "seed-report") {
    return "foreign-only";
  }
  return concept.ownership !== undefined && concept.locality !== undefined
    ? "authoritative"
    : "partial";
}

function cautionsOf(
  concept: WorkspaceConcept,
  coverage: WorkspaceConceptCoverage,
  topology: WorkspaceConceptTopology,
  graph: WorkspaceGraphAnalysis,
  analyzed: Set<string>
): WorkspaceConceptCaution[] {
  const cautions: WorkspaceConceptCaution[] = [];
  if (coverage === "foreign-only") {
    cautions.push({
      detail:
        "Known only as an overlap partner; the declaring package's report was not ingested, so roles and centers are unavailable.",
      entities: [concept.package],
      kind: "foreign-only",
    });
  } else if (coverage === "partial") {
    cautions.push({
      detail: "The seed report lacks ownership or locality for this concept.",
      entities: [concept.id],
      kind: "partial-analysis",
    });
  }
  const unanalyzed = topology.participatingPackages.filter(
    (pkg) => !analyzed.has(pkg)
  );
  if (graph.certainty === "partial" && unanalyzed.length > 0) {
    cautions.push({
      detail:
        "Participating packages without a report; paths, layers, and regions are lower bounds.",
      entities: unanalyzed,
      kind: "partial-graph-coverage",
    });
  }
  if (topology.unknownPackages.length > 0) {
    cautions.push({
      detail: "Presence packages that are not workspace graph nodes.",
      entities: topology.unknownPackages,
      kind: "package-not-in-graph",
    });
  }
  if (topology.usageOnlyEdges.length > 0) {
    cautions.push({
      detail:
        "Concept packages joined by a re-export-only edge; usage flow without a structural dependency edge.",
      entities: topology.usageOnlyEdges,
      kind: "usage-only-flow",
    });
  }
  if (
    coverage === "authoritative" &&
    (concept.relationships?.implements ?? 0) === 0 &&
    (concept.ownership?.center.implementations.length ?? 0) === 0
  ) {
    cautions.push({
      detail:
        "No `implements` clause names the concept; structural conformance is unobserved.",
      entities: [],
      kind: "no-implementation-evidence",
    });
  }
  return cautions;
}

function placeConcept(
  concept: WorkspaceConcept,
  graph: WorkspaceGraphAnalysis,
  index: GraphIndex,
  tables: {
    overlaps: Map<string, WorkspaceConceptOverlap>;
    couplings: Map<string, WorkspaceCouplingPair>;
    reviews: Map<string, ArchitecturalReviewDisposition>;
    analyzed: Set<string>;
    anchored: Set<string>;
  },
  packageOf: (module: string) => string | null,
  config: AnalysisConfig
): { placement: WorkspaceConceptPlacement; table: RoleTable } {
  const coverage = coverageOf(concept);
  const table = rolesOf(concept, tables.overlaps, packageOf);
  const presence = presenceOf(concept, table);
  const edges = conceptEdges(index, presence, table);
  const topology = topologyOf(index, presence, edges);
  const span = spanOf(index, presence, topology);
  const flow = flowOf(presence, topology);
  const relationships = relationshipsOf(concept, tables.overlaps, packageOf);
  const shapes =
    coverage === "foreign-only"
      ? []
      : shapesOf(
          presence,
          topology,
          span,
          flow,
          relationships,
          graph.certainty,
          config
        );
  const participation = concept.ownership?.participation ?? [];
  const byVolume = [...edges].sort(
    (a, b) =>
      (b.volume.importSites ?? b.volume.moduleEdges) -
        (a.volume.importSites ?? a.volume.moduleEdges) || byId(a.id, b.id)
  );
  const bySeverance = [...edges].sort(
    (a, b) =>
      b.structure.severedPairs - a.structure.severedPairs || byId(a.id, b.id)
  );
  const highestVolume = byVolume[0];
  const highestSeverance = bySeverance[0];
  const centers = centersOf(index, concept);
  const evolution = evolutionOf(index, concept, tables.couplings, packageOf);
  const reviewDisposition = tables.reviews.get(concept.id);
  const placement: WorkspaceConceptPlacement = {
    concept: {
      file: concept.file,
      id: concept.id,
      kind: concept.kind,
      name: concept.name,
      package: concept.package,
    },
    coverage,
    extent: {
      behaviorPackages: presence.behaviorPackages.length,
      converterPackages: presence.converterPackages.length,
      implementationPackages: presence.implementationPackages.length,
      implementations:
        concept.ownership === undefined
          ? null
          : participation.reduce((sum, p) => sum + p.implementations, 0),
      moduleCount: concept.distribution?.moduleCount ?? null,
      packageCount: presence.packages.length,
      referencePackages: presence.referencePackages.length,
      references: concept.distribution?.references ?? null,
      representationPackages: presence.representationPackages.length,
      representations: concept.representations?.total ?? null,
    },
    presence,
    ...(centers !== undefined && { centers }),
    boundaries: {
      behaviorBoundaries: span.behaviorBoundaryCount,
      count: edges.length,
      implementationBoundaries: span.implementationBoundaryCount,
      ...(highestVolume !== undefined && { highestVolume: highestVolume.id }),
      ...(highestSeverance !== undefined &&
        highestSeverance.structure.severedPairs > 0 && {
          highestSeverance: highestSeverance.id,
        }),
      seams: edges.filter((e) => e.structure.seam).map((e) => e.id),
    },
    flow,
    propagation:
      coverage === "foreign-only"
        ? "unmeasured"
        : propagationOf(index, presence, topology),
    relationships: {
      conversions: relationships.filter((r) => r.conversions.length > 0),
      overlaps: relationships,
    },
    shapes,
    span,
    topology,
    ...(evolution !== undefined && { evolution }),
    ...(coverage !== "foreign-only" && {
      architecture: {
        ...(concept.ownership !== undefined && {
          ownershipAlignment: concept.ownership.alignment,
        }),
        ...(concept.locality !== undefined && {
          localityShape: concept.locality.shape,
        }),
        ...(concept.recentering !== undefined && {
          recenteringStatus: concept.recentering.status,
        }),
        ...(concept.recentering?.findingId !== undefined && {
          recenteringFinding: concept.recentering.findingId,
        }),
        ...(reviewDisposition !== undefined && { reviewDisposition }),
        anchored:
          tables.anchored.has(concept.package) ||
          (concept.locality?.anchored ?? false),
      },
    }),
    cautions: cautionsOf(concept, coverage, topology, graph, tables.analyzed),
  };
  return { placement, table };
}

const DIRECTION_ROLES: [
  WorkspaceConceptDirectionKind,
  keyof Pick<
    WorkspaceConceptPresence,
    | "implementationPackages"
    | "behaviorPackages"
    | "representationPackages"
    | "referencePackages"
    | "converterPackages"
  >,
][] = [
  ["semantic-to-implementation", "implementationPackages"],
  ["semantic-to-behavior", "behaviorPackages"],
  ["semantic-to-representation", "representationPackages"],
  ["semantic-to-usage", "referencePackages"],
  ["semantic-to-conversion", "converterPackages"],
];

function directionsOf(
  index: GraphIndex,
  placements: WorkspaceConceptPlacement[]
): WorkspaceConceptDirection[] {
  const table = new Map<string, WorkspaceConceptDirection>();
  for (const placement of placements) {
    if (placement.coverage === "foreign-only") {
      continue;
    }
    const from = placement.presence.declaredPackage;
    for (const [kind, field] of DIRECTION_ROLES) {
      for (const to of placement.presence[field]) {
        if (to === from) {
          continue;
        }
        const id = `${from}→${to}:${kind}`;
        const entry = table.get(id) ?? {
          concepts: [],
          count: 0,
          dependencyPath: {
            forward: hops(index, from, to),
            reverse: hops(index, to, from),
            usageOnly: joinedByUsageOnly(index, from, to),
          },
          from,
          id,
          kind,
          to,
        };
        entry.concepts.push(placement.concept.id);
        entry.count += 1;
        table.set(id, entry);
      }
    }
  }
  return [...table.values()]
    .map((d) => ({ ...d, concepts: d.concepts.sort(byId) }))
    .sort((a, b) => b.count - a.count || byId(a.id, b.id));
}

function boundaryLoadsOf(
  index: GraphIndex,
  placements: WorkspaceConceptPlacement[]
): WorkspaceBoundaryConceptLoad[] {
  const table = new Map<string, WorkspaceBoundaryConceptLoad>();
  const load = (
    edge: WorkspacePackageGraphEdge
  ): WorkspaceBoundaryConceptLoad =>
    table.get(edge.id) ?? {
      boundaryId: edge.id,
      conceptCount: 0,
      concepts: [],
      from: edge.from,
      roles: {
        behavior: 0,
        conversion: 0,
        implementation: 0,
        representation: 0,
        semanticUse: 0,
      },
      structure: {
        alternativeRoutes: edge.alternativeRoutes,
        seam: index.seams.has(edge.id),
        severedPairs: edge.severedPairs,
        weakBridge: edge.weakBridge,
      },
      to: edge.to,
      volume: {
        distinctSymbols: edge.weights.distinctSymbols,
        importSites: edge.weights.importSites,
        moduleEdges: edge.weights.moduleEdges,
        references: edge.weights.references,
      },
    };
  for (const placement of placements) {
    for (const conceptEdge of placement.topology.edges) {
      const edge = index.edges.get(conceptEdge.id);
      if (edge === undefined) {
        continue;
      }
      const entry = load(edge);
      entry.concepts.push(placement.concept.id);
      entry.conceptCount += 1;
      for (const role of conceptEdge.roles) {
        if (role === "semantic-use") {
          entry.roles.semanticUse += 1;
        } else if (role === "behavior") {
          entry.roles.behavior += 1;
        } else if (role === "implementation") {
          entry.roles.implementation += 1;
        } else if (role === "representation") {
          entry.roles.representation += 1;
        } else {
          entry.roles.conversion += 1;
        }
      }
      table.set(edge.id, entry);
    }
  }
  return [...table.values()]
    .map((b) => ({ ...b, concepts: b.concepts.sort(byId) }))
    .sort(
      (a, b) =>
        b.conceptCount - a.conceptCount || byId(a.boundaryId, b.boundaryId)
    );
}

function seamLoadsOf(
  graph: WorkspaceGraphAnalysis,
  index: GraphIndex,
  loads: WorkspaceBoundaryConceptLoad[]
): WorkspaceBoundaryConceptLoad[] {
  const byBoundary = new Map(loads.map((l) => [l.boundaryId, l]));
  return graph.seams.flatMap((seam) => {
    const known = byBoundary.get(seam.id);
    if (known !== undefined) {
      return [known];
    }
    const edge = index.edges.get(seam.id);
    if (edge === undefined) {
      return [];
    }
    return [
      {
        boundaryId: edge.id,
        conceptCount: 0,
        concepts: [],
        from: edge.from,
        roles: {
          behavior: 0,
          conversion: 0,
          implementation: 0,
          representation: 0,
          semanticUse: 0,
        },
        structure: {
          alternativeRoutes: edge.alternativeRoutes,
          seam: true,
          severedPairs: edge.severedPairs,
          weakBridge: edge.weakBridge,
        },
        to: edge.to,
        volume: {
          distinctSymbols: edge.weights.distinctSymbols,
          importSites: edge.weights.importSites,
          moduleEdges: edge.weights.moduleEdges,
          references: edge.weights.references,
        },
      },
    ];
  });
}

function packageRolesOf(
  workspace: WorkspaceReport,
  placements: WorkspaceConceptPlacement[],
  tables: Map<string, RoleTable>
): WorkspacePackageConceptRoleSummary[] {
  const rows = new Map<string, WorkspacePackageConceptRoleSummary>();
  const analyzed = new Map(
    workspace.packages.packages.map((p) => [p.id, p.analyzed])
  );
  const row = (pkg: string): WorkspacePackageConceptRoleSummary => {
    const existing = rows.get(pkg);
    if (existing !== undefined) {
      return existing;
    }
    const created: WorkspacePackageConceptRoleSummary = {
      analyzed: analyzed.get(pkg) ?? false,
      asymmetry: {
        behavingMinusDeclared: 0,
        implementingMinusDeclared: 0,
        representingMinusDeclared: 0,
      },
      behaviorCenters: 0,
      declaredConcepts: 0,
      evolutionCenters: 0,
      implementationCenters: 0,
      package: pkg,
      participating: {
        behaving: 0,
        converting: 0,
        implementing: 0,
        representing: 0,
        total: 0,
        using: 0,
      },
      representationCenters: 0,
      semanticCenters: 0,
      usageCenters: 0,
    };
    rows.set(pkg, created);
    return created;
  };
  for (const pkg of workspace.packages.packages) {
    row(pkg.id);
  }
  for (const placement of placements) {
    row(placement.concept.package).declaredConcepts += 1;
    const centers = placement.centers;
    if (centers !== undefined) {
      if (centers.semantic !== undefined) {
        row(centers.semantic).semanticCenters += 1;
      }
      if (centers.behavior !== undefined) {
        row(centers.behavior).behaviorCenters += 1;
      }
      if (centers.representation !== undefined) {
        row(centers.representation).representationCenters += 1;
      }
      if (centers.usage !== undefined) {
        row(centers.usage).usageCenters += 1;
      }
      if (centers.evolution !== undefined) {
        row(centers.evolution).evolutionCenters += 1;
      }
      for (const pkg of centers.implementations) {
        row(pkg).implementationCenters += 1;
      }
    }
    const table = tables.get(placement.concept.id);
    if (table === undefined) {
      continue;
    }
    for (const [pkg, roles] of table.roles) {
      const entry = row(pkg).participating;
      entry.total += 1;
      if (roles.has("implements")) {
        entry.implementing += 1;
      }
      if (roles.has("behaves")) {
        entry.behaving += 1;
      }
      if (roles.has("represents")) {
        entry.representing += 1;
      }
      if (roles.has("uses")) {
        entry.using += 1;
      }
      if (roles.has("converts")) {
        entry.converting += 1;
      }
    }
  }
  return [...rows.values()]
    .map((r) => ({
      ...r,
      asymmetry: {
        behavingMinusDeclared: r.participating.behaving - r.declaredConcepts,
        implementingMinusDeclared:
          r.participating.implementing - r.declaredConcepts,
        representingMinusDeclared:
          r.participating.representing - r.declaredConcepts,
      },
    }))
    .sort((a, b) => byId(a.package, b.package));
}

function familiesOf(
  placements: WorkspaceConceptPlacement[]
): WorkspaceConceptFamilyTopology[] {
  return placements.flatMap((placement) => {
    const implementations = placement.presence.implementationPackages;
    if (placement.coverage === "foreign-only" || implementations.length === 0) {
      return [];
    }
    const contract = placement.presence.declaredPackage;
    const paths = placement.flow.semanticToImplementations;
    const categories: WorkspaceContractFamilyCategory[] = [];
    const foreign = implementations.filter((pkg) => pkg !== contract);
    if (foreign.length === 0) {
      categories.push("single-package-contract");
    } else {
      categories.push("cross-package-implementation");
    }
    if (implementations.length >= 2) {
      categories.push("parallel-implementation");
    }
    if (
      paths.some((p) => p.relation === "direct" || p.relation === "indirect")
    ) {
      categories.push("downstream-implementation");
    }
    if (paths.some((p) => p.relation === "disconnected")) {
      categories.push("disconnected-implementation");
    }
    const implementationSet = new Set(implementations);
    return [
      {
        boundaries: placement.topology.edges
          .filter((e) => e.roles.includes("implementation"))
          .map((e) => e.id),
        categories,
        concept: placement.concept.id,
        contractPackage: contract,
        couplings: (placement.evolution?.strongMemberCouplings ?? []).map(
          (c) => c.id
        ),
        implementationPackages: implementations,
        layers: placement.topology.packageLayers.filter(
          (l) => l.package === contract || implementationSet.has(l.package)
        ),
        name: placement.concept.name,
        paths,
      },
    ];
  });
}

function pairsOf(
  index: GraphIndex,
  overlaps: WorkspaceConceptOverlap[],
  couplings: Map<string, WorkspaceCouplingPair>,
  packageOf: (module: string) => string | null
): WorkspaceConceptPairTopology[] {
  return overlaps
    .map((pair): WorkspaceConceptPairTopology => {
      const leftNode = index.nodes.get(pair.left.package);
      const rightNode = index.nodes.get(pair.right.package);
      const both = leftNode !== undefined && rightNode !== undefined;
      const forwardId = `${pair.left.package}→${pair.right.package}`;
      const reverseId = `${pair.right.package}→${pair.left.package}`;
      const coupling = couplings.get(pairId(pair.left.file, pair.right.file));
      return {
        bidirectionalConversion: pair.bidirectionalConversion,
        converterPackages: sorted(
          pair.conversions.flatMap((c) => {
            const pkg = packageOf(c.file);
            return pkg === null ? [] : [pkg];
          })
        ),
        directEdge: index.edges.has(forwardId)
          ? forwardId
          : index.edges.has(reverseId)
            ? reverseId
            : null,
        left: pair.left.id,
        leftPackage: pair.left.package,
        pair: pair.id,
        path: {
          forward: hops(index, pair.left.package, pair.right.package),
          reverse: hops(index, pair.right.package, pair.left.package),
        },
        right: pair.right.id,
        rightPackage: pair.right.package,
        sameComponent: both ? leftNode.component === rightNode.component : null,
        sameLayer: both ? leftNode.layer === rightNode.layer : null,
        samePackage: pair.left.package === pair.right.package,
        shapes: pair.shapes,
        ...(coupling !== undefined && {
          coupling: {
            coChangeCommits: coupling.coChangeCommits,
            context: coupling.context,
            staticPath: coupling.staticPath,
          },
        }),
      };
    })
    .sort((a, b) => byId(a.pair, b.pair));
}

function histogram(values: (number | null)[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = value === null ? "null" : String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort((a, b) => {
      if (a[0] === "null") {
        return 1;
      }
      if (b[0] === "null") {
        return -1;
      }
      return Number(a[0]) - Number(b[0]);
    })
  );
}

function distributionsOf(
  placements: WorkspaceConceptPlacement[]
): WorkspaceConceptSpanDistribution {
  const measured = placements.filter((p) => p.coverage !== "foreign-only");
  return {
    boundaries: histogram(measured.map((p) => p.span.boundaryCount)),
    layerSpan: histogram(measured.map((p) => p.span.layerSpan)),
    packages: histogram(measured.map((p) => p.span.packages)),
    responsibilityLayerSpan: histogram(
      measured.map((p) => p.span.responsibilityLayerSpan)
    ),
    usageLayerSpan: histogram(measured.map((p) => p.span.usageLayerSpan)),
  };
}

export function analyzeWorkspaceConcepts(
  workspace: WorkspaceReport,
  graph: WorkspaceGraphAnalysis,
  config: AnalysisConfig = ANALYSIS_CONFIG
): WorkspaceConceptIntelligence {
  const index = indexGraph(graph);
  const packageOf = modulePackageResolver(workspace);
  const tables = {
    analyzed: new Set(
      workspace.packages.packages.flatMap((p) => (p.analyzed ? [p.id] : []))
    ),
    anchored: new Set(
      workspace.packages.packages.flatMap((p) => (p.anchored ? [p.id] : []))
    ),
    couplings: new Map(workspace.evolution.couplings.map((c) => [c.id, c])),
    overlaps: new Map(workspace.concepts.overlaps.map((o) => [o.id, o])),
    reviews: new Map(
      workspace.architecture.recentering.reviews.map((r) => [
        r.conceptId,
        r.disposition,
      ])
    ),
  };
  const roleTables = new Map<string, RoleTable>();
  const placements = [...workspace.concepts.concepts]
    .sort((a, b) => byId(a.id, b.id))
    .map((concept) => {
      const { placement, table } = placeConcept(
        concept,
        graph,
        index,
        tables,
        packageOf,
        config
      );
      roleTables.set(concept.id, table);
      return placement;
    });
  const directions = directionsOf(index, placements);
  const boundaries = boundaryLoadsOf(index, placements);
  const families = familiesOf(placements);
  const pairs = pairsOf(
    index,
    workspace.concepts.overlaps,
    tables.couplings,
    packageOf
  );
  const count = (shape: WorkspaceConceptShape) =>
    placements.filter((p) => p.shapes.includes(shape)).length;
  const conversionPairs = workspace.concepts.overlaps.filter(
    (o) => o.conversions.length > 0
  ).length;
  const measured = placements.filter((p) => p.coverage !== "foreign-only");
  const foreignOnly = placements.filter((p) => p.coverage === "foreign-only");
  const unknown = sorted(placements.flatMap((p) => p.topology.unknownPackages));
  const cautions: WorkspaceConceptIntelligenceCaution[] = [];
  if (graph.certainty === "partial") {
    cautions.push({
      detail:
        "Package coverage is partial; concept paths, layers, regions, and boundary loads are lower bounds.",
      entities: workspace.ingestion.coverage.missingPackages,
      kind: "partial-coverage",
    });
  }
  if (foreignOnly.length > 0) {
    cautions.push({
      detail: `${foreignOnly.length} concepts are known only as overlap partners and carry no roles, centers, or shapes.`,
      entities: sorted(foreignOnly.map((p) => p.concept.package)),
      kind: "foreign-only-concepts",
    });
  }
  if (unknown.length > 0) {
    cautions.push({
      detail: "Concept presence names packages that are not graph nodes.",
      entities: unknown,
      kind: "unknown-packages",
    });
  }
  return {
    boundaries,
    cautions,
    certainty: graph.certainty,
    concepts: placements,
    directions,
    distributions: distributionsOf(placements),
    families,
    packageRoles: packageRolesOf(workspace, placements, roleTables),
    relationships: {
      bidirectionalConversionPairs: pairs.filter(
        (p) => p.bidirectionalConversion
      ).length,
      conversionPairs,
      crossPackagePairs: pairs.filter((p) => !p.samePackage).length,
      overlapPairs: pairs.length,
      pairs,
    },
    seams: seamLoadsOf(graph, index, boundaries),
    summary: {
      authoritative: placements.filter((p) => p.coverage === "authoritative")
        .length,
      conceptBearingBoundaries: boundaries.length,
      concepts: placements.length,
      conversionPairs,
      crossLayer: count("cross-layer"),
      crossPackage: measured.filter((p) => p.presence.packages.length > 1)
        .length,
      directions: directions.length,
      downstreamImplemented: count("downstream-implemented"),
      families: families.length,
      foreignOnly: foreignOnly.length,
      local: count("local"),
      multiRegion: count("multi-region"),
      overlapPairs: pairs.length,
      parallelImplementation: count("parallel-implementation"),
      partial: placements.filter((p) => p.coverage === "partial").length,
      representationSplit: count("representation-split"),
      upstreamConsumed: count("upstream-consumed"),
    },
  };
}
