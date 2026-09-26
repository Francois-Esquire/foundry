import type {
  RecenteringBehaviorModule,
  RecenteringBoundaryUse,
  RecenteringFacts,
  RecenteringSourceCoupling,
} from "./concept-recentering";
import type { ScenarioFacts } from "./concept-scenarios";
import { deriveScenarioFacts } from "./concept-scenarios";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type {
  BehavioralLocalityShape,
  BehaviorImpact,
  BoundaryImpact,
  DependencyImpact,
  EvolutionImpact,
  ImpactCertainty,
  ImplementationImpact,
  IntentImpact,
  LocalityImpact,
  LocalitySnapshot,
  MiscenteredConceptFinding,
  MiscenteredConceptReport,
  RecenteringLocalityContext,
  RecenteringScenario,
  RecenteringScenarioReport,
  RepresentationImpact,
  ScenarioBehaviorPlacement,
  ScenarioBoundaryState,
  ScenarioConstraintImpact,
  ScenarioDependencyEdge,
  ScenarioImpactAnalysis,
  ScenarioImpactFinding,
  ScenarioImpactReport,
  ScenarioImpactSummary,
  ScenarioImpactUncertainty,
  ScenarioMetricDelta,
  ScenarioPlacement,
  ScenarioPreservation,
  ScenarioResponsibility,
  ScenarioStructuralChange,
  ScenarioStructuralChangeKind,
  SurfaceImpact,
} from "./types";

/** What the simulator reads; derived once per finding from the V8.0 facts and the V8.2 derivation. */
export interface ScenarioImpactFacts {
  /** Edges touching the home with V5 interaction data. */
  boundaries: RecenteringBoundaryUse[];
  couplings: RecenteringSourceCoupling[];
  disconnectedPairs: { left: string; right: string }[];
  /** V7.4 edges between source behavior packages. */
  edges: { from: string; to: string }[];
  historyAvailable: boolean;
  hotspotModules: string[];
  locality: RecenteringLocalityContext;
  modules: RecenteringBehaviorModule[];
  scenario: ScenarioFacts;
  seed: { module: string; packagePublic: boolean; externallyUsed: boolean };
  /** Packages importing the seed module, with their import sites into it. */
  seedImporters: { package: string; importSites: number }[];
  /** Parameter consumption and construction per package; never relocated. */
  weakByPackage: { package: string; weak: number }[];
}

export function deriveScenarioImpactFacts(
  finding: MiscenteredConceptFinding,
  facts: RecenteringFacts,
  config: AnalysisConfig = ANALYSIS_CONFIG
): ScenarioImpactFacts {
  return {
    boundaries: [...facts.boundaries, ...facts.consumerBoundaries],
    couplings: facts.sourceCouplings,
    disconnectedPairs: facts.disconnectedPairs,
    edges: facts.behaviorEdges,
    historyAvailable: facts.history !== undefined,
    hotspotModules: facts.hotspotModules,
    locality: facts.locality,
    modules: facts.behaviorModules,
    scenario: deriveScenarioFacts(finding, facts, config),
    seed: {
      externallyUsed: facts.seed.externallyUsed,
      module: facts.seed.module,
      packagePublic: facts.seed.packagePublic,
    },
    seedImporters: facts.seedImportSites,
    weakByPackage: facts.behavior.byPackage
      .filter((row) => row.weak > 0)
      .map((row) => ({ package: row.package, weak: row.weak })),
  };
}

const CHANGE_ORDER: ScenarioStructuralChangeKind[] = [
  "semantic-center-change",
  "behavior-center-change",
  "behavior-consolidation",
  "boundary-elimination",
  "boundary-reduction",
  "boundary-addition",
  "dependency-elimination",
  "dependency-addition",
  "surface-relocation",
  "representation-boundary-preserved",
  "representation-boundary-added",
  "implementation-split-preserved",
  "anchor-constraint",
];

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function packagesOf(
  placement: ScenarioPlacement,
  responsibility: ScenarioResponsibility
): string[] {
  return (
    placement.responsibilities.find(
      (row) => row.responsibility === responsibility
    )?.packages ?? []
  );
}

function responsibilitiesOf(
  placement: ScenarioPlacement,
  pkg: string
): ScenarioResponsibility[] {
  return placement.responsibilities
    .filter((row) => row.packages.includes(pkg))
    .map((row) => row.responsibility);
}

function sameSet(left: string[], right: string[]): boolean {
  return unique(left).join(",") === unique(right).join(",");
}

function edgeLabel(from: string, to: string): string {
  return `${from} → ${to}`;
}

function metric(
  current: number | null,
  predicted: number | null,
  certainty: ImpactCertainty
): ScenarioMetricDelta {
  return {
    certainty,
    current,
    delta: current === null || predicted === null ? null : predicted - current,
    predicted,
  };
}

/** Where a module would sit; `to` absent means the scenario names no destination. */
interface Relocation {
  from: string;
  module: string;
  to?: string;
}

/**
 * Modules a scenario would carry. A package leaving `domain-behavior`
 * carries its return behavior, leaving `implementation` its adapters,
 * leaving `conversion` its converters; the seed module follows the
 * semantic contract. Weak behavior never moves (§18). The destination is
 * known only when the proposed placement names exactly one package for
 * that responsibility.
 */
function relocations(
  facts: ScenarioImpactFacts,
  current: ScenarioPlacement,
  proposed: ScenarioPlacement
): Map<string, Relocation> {
  const out = new Map<string, Relocation>();
  const leaves = (pkg: string, responsibility: ScenarioResponsibility) =>
    packagesOf(current, responsibility).includes(pkg) &&
    !packagesOf(proposed, responsibility).includes(pkg);
  const destination = (responsibility: ScenarioResponsibility) => {
    const packages = packagesOf(proposed, responsibility);
    return packages.length === 1 ? packages[0] : undefined;
  };
  const place = (module: string, from: string, to: string | undefined) => {
    const found = out.get(module);
    if (found === undefined) {
      out.set(module, { from, module, ...(to !== undefined && { to }) });
    } else if (found.to !== to) {
      delete found.to;
    }
  };
  for (const row of facts.modules) {
    if (row.return > 0 && leaves(row.package, "domain-behavior")) {
      place(row.module, row.package, destination("domain-behavior"));
    }
    if (row.implementation > 0 && leaves(row.package, "implementation")) {
      place(row.module, row.package, destination("implementation"));
    }
    if (row.conversion > 0 && leaves(row.package, "conversion")) {
      place(row.module, row.package, destination("conversion"));
    }
  }
  if (proposed.semanticCenter !== current.semanticCenter) {
    place(facts.seed.module, current.semanticCenter, proposed.semanticCenter);
  }
  return out;
}

function behaviorImpact(
  facts: ScenarioImpactFacts,
  current: ScenarioPlacement,
  proposed: ScenarioPlacement
): BehaviorImpact {
  const rows = new Map<string, ScenarioBehaviorPlacement>();
  const rowOf = (pkg: string) => {
    let row = rows.get(pkg);
    if (row === undefined) {
      row = {
        conversion: 0,
        governing: 0,
        implementation: 0,
        package: pkg,
        weak: 0,
      };
      rows.set(pkg, row);
    }
    return row;
  };
  for (const row of facts.scenario.behavior) {
    const found = rowOf(row.package);
    found.governing = row.governing;
    found.implementation = row.adapters;
    found.conversion = row.conversions;
  }
  for (const row of facts.weakByPackage) {
    rowOf(row.package).weak = row.weak;
  }
  const currentRows = [...rows.values()]
    .map((row) => ({ ...row }))
    .sort((a, b) => a.package.localeCompare(b.package));

  const predicted = new Map(
    currentRows.map((row) => [row.package, { ...row }])
  );
  const predictedRow = (pkg: string) => {
    let row = predicted.get(pkg);
    if (row === undefined) {
      row = {
        conversion: 0,
        governing: 0,
        implementation: 0,
        package: pkg,
        weak: 0,
      };
      predicted.set(pkg, row);
    }
    return row;
  };
  const leaves = (pkg: string, responsibility: ScenarioResponsibility) =>
    packagesOf(current, responsibility).includes(pkg) &&
    !packagesOf(proposed, responsibility).includes(pkg);
  const destination = (responsibility: ScenarioResponsibility) => {
    const packages = packagesOf(proposed, responsibility);
    return packages.length === 1 ? packages[0] : undefined;
  };
  let relocated = 0;
  let unplaced = 0;
  // V8.1 counts converters inside `governing` and reports adapters beside
  // it, so a conversion move debits both while an adapter move debits only
  // `implementation`.
  const move = (
    from: ScenarioBehaviorPlacement,
    count: number,
    responsibility: ScenarioResponsibility,
    fields: ("governing" | "implementation" | "conversion")[]
  ) => {
    if (count === 0) {
      return;
    }
    relocated += count;
    for (const field of fields) {
      from[field] = (from[field] ?? 0) - count;
    }
    const to = destination(responsibility);
    if (to === undefined) {
      unplaced += count;
      return;
    }
    const target = predictedRow(to);
    for (const field of fields) {
      target[field] = (target[field] ?? 0) + count;
    }
  };
  for (const row of currentRows) {
    const target = predictedRow(row.package);
    const returns = (row.governing ?? 0) - (row.conversion ?? 0);
    if (leaves(row.package, "domain-behavior")) {
      move(target, returns, "domain-behavior", ["governing"]);
    }
    if (leaves(row.package, "implementation")) {
      move(target, row.implementation ?? 0, "implementation", [
        "implementation",
      ]);
    }
    if (leaves(row.package, "conversion")) {
      move(target, row.conversion ?? 0, "conversion", [
        "governing",
        "conversion",
      ]);
    }
  }
  const predictedRows = [...predicted.values()].sort((a, b) =>
    a.package.localeCompare(b.package)
  );
  const governingIn = (list: ScenarioBehaviorPlacement[]) =>
    new Set(
      list.filter((row) => (row.governing ?? 0) > 0).map((row) => row.package)
    );
  const before = governingIn(currentRows);
  const after = governingIn(predictedRows);
  const total = currentRows.reduce((sum, row) => sum + (row.governing ?? 0), 0);
  return {
    certainty: unplaced > 0 ? "unknown" : "certain",
    consumerBehaviorUnaffected: currentRows.reduce(
      (sum, row) => sum + row.weak,
      0
    ),
    currentByPackage: currentRows,
    governingBehaviorPreserved: total - relocated,
    governingBehaviorRelocated: relocated,
    governingBehaviorUnplaced: unplaced,
    packagesAdded: [...after].filter((pkg) => !before.has(pkg)).sort(),
    packagesRemoved: [...before].filter((pkg) => !after.has(pkg)).sort(),
    predictedByPackage: predictedRows,
  };
}

function holdsSourceBehavior(row: ScenarioBehaviorPlacement): boolean {
  return (
    (row.governing ?? 0) > 0 ||
    (row.implementation ?? 0) > 0 ||
    (row.conversion ?? 0) > 0 ||
    row.weak > 0
  );
}

/** Packages that would still hold source behavior: weak behavior stays, so a vacated package with consumers stays in the span. */
function predictedSpan(behavior: BehaviorImpact): string[] {
  return behavior.predictedByPackage
    .filter(holdsSourceBehavior)
    .map((row) => row.package)
    .sort();
}

interface EdgePlan {
  added: ScenarioDependencyEdge[];
  current: ScenarioDependencyEdge[];
  states: ScenarioBoundaryState[];
}

/**
 * Concept-scoped edges: the V7.4 behavior-package edges plus every package
 * importing the seed module. An edge changes only where a concept module
 * on it relocates; consumers never relocate, so a consumer edge changes
 * only when the contract it imports moves, and then its fate is unresolved.
 */
function planEdges(
  facts: ScenarioImpactFacts,
  current: ScenarioPlacement,
  proposed: ScenarioPlacement,
  moves: Map<string, Relocation>,
  span: string[],
  config: AnalysisConfig
): EdgePlan {
  const home = current.semanticCenter;
  const requireExclusive =
    config.recentering.impact.boundary
      .requireExclusiveConceptContributionForElimination;
  const measured = new Map(
    facts.boundaries.map((boundary) => [
      edgeLabel(boundary.from, boundary.to),
      boundary,
    ])
  );
  const seen = new Set<string>();
  const edges: { from: string; to: string }[] = [];
  for (const edge of [
    ...facts.edges,
    ...facts.seedImporters
      .filter((row) => row.package !== home)
      .map((row) => ({ from: row.package, to: home })),
  ]) {
    const label = edgeLabel(edge.from, edge.to);
    if (seen.has(label)) {
      continue;
    }
    seen.add(label);
    edges.push(edge);
  }
  edges.sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
  );

  const currentEdges: ScenarioDependencyEdge[] = [];
  const states: ScenarioBoundaryState[] = [];
  for (const edge of edges) {
    const label = edgeLabel(edge.from, edge.to);
    const boundary = measured.get(label);
    const seedImports =
      facts.seedImporters.find((row) => row.package === edge.from)
        ?.importSites ?? 0;
    const conceptModules =
      boundary === undefined
        ? []
        : unique([
            ...boundary.conceptImportingModules,
            ...boundary.conceptImportedModules,
          ]);
    const sum = (rows: { importSites: number }[]) =>
      rows.reduce((total, row) => total + row.importSites, 0);
    const importingSites =
      boundary === undefined ? null : sum(boundary.conceptImportSitesByModule);
    const importedSites =
      boundary === undefined
        ? edge.to === home
          ? seedImports
          : null
        : sum(boundary.conceptImportedSitesByModule);
    // Import sites naming a concept module are the concept's share of the
    // edge. Exclusivity asks whether anything else crosses it: with the
    // gate on, every imported module must be the concept's; off, every
    // importing module.
    const conceptImportSites = importedSites;
    const exclusive =
      boundary !== undefined &&
      boundary.importSites > 0 &&
      (requireExclusive
        ? importedSites === boundary.importSites
        : importingSites === boundary.importSites);
    const dependency: ScenarioDependencyEdge = {
      conceptImportSites,
      conceptModules,
      exclusive,
      from: edge.from,
      importSites: boundary?.importSites ?? null,
      measured: boundary !== undefined,
      to: edge.to,
    };
    currentEdges.push(dependency);

    // The seed module leaves an edge only with the contract: behavior it
    // hosts may move, the declaration others import stays.
    const semanticMoves = proposed.semanticCenter !== home;
    const leavesEdge = (module: string) =>
      moves.has(module) && (module !== facts.seed.module || semanticMoves);
    const vacated = conceptModules.filter(leavesEdge);
    const remaining = conceptModules.filter((module) => !leavesEdge(module));
    // The concept crosses the edge from its importing modules to its
    // imported modules; the interaction ends when either side empties.
    const sideEmpties = (modules: string[]) =>
      modules.length > 0 && modules.every(leavesEdge);
    const interactionEnds =
      boundary !== undefined &&
      (sideEmpties(boundary.conceptImportingModules) ||
        sideEmpties(boundary.conceptImportedModules));
    const endpointChanged =
      responsibilitiesOf(current, edge.from).join() !==
        responsibilitiesOf(proposed, edge.from).join() ||
      responsibilitiesOf(current, edge.to).join() !==
        responsibilitiesOf(proposed, edge.to).join();
    // A package that imports a contract which moves elsewhere keeps or
    // drops that import depending on an exposure strategy nobody chose
    // (§53); only the new center itself certainly stops importing it.
    const contractRetargets =
      semanticMoves &&
      vacated.includes(facts.seed.module) &&
      edge.to === home &&
      edge.from !== proposed.semanticCenter;
    let outcome: ScenarioBoundaryState["outcome"];
    let certainty: ImpactCertainty;
    if (boundary === undefined) {
      // No interaction data: a foreign-to-foreign edge with a changed
      // endpoint cannot be settled.
      outcome = endpointChanged ? "uncertain" : "preserved";
      certainty = endpointChanged ? "unknown" : "certain";
    } else if (contractRetargets) {
      outcome = "uncertain";
      certainty = "unknown";
    } else if (vacated.length === 0) {
      outcome = "preserved";
      certainty = "certain";
    } else if (interactionEnds && exclusive) {
      outcome = "eliminated";
      certainty = "conditional";
    } else {
      outcome = "reduced";
      certainty = "conditional";
    }
    const vacatedImportSites =
      boundary === undefined
        ? null
        : Math.min(
            boundary.importSites,
            sum(
              boundary.conceptImportSitesByModule.filter((row) =>
                vacated.includes(row.module)
              )
            ) +
              sum(
                boundary.conceptImportedSitesByModule.filter((row) =>
                  vacated.includes(row.module)
                )
              )
          );
    states.push({
      certainty,
      conceptImportSites,
      conceptImportSitesRemoved: vacatedImportSites,
      conceptInteractionEnds: interactionEnds && !contractRetargets,
      edge: label,
      exclusive,
      from: edge.from,
      importSites: dependency.importSites,
      outcome,
      remainingModules: remaining,
      to: edge.to,
      vacatedModules: vacated,
    });
  }

  const added: ScenarioDependencyEdge[] = [];
  const needs = (from: string, to: string) => {
    if (from === to || seen.has(edgeLabel(from, to))) {
      return;
    }
    seen.add(edgeLabel(from, to));
    added.push({
      conceptImportSites: null,
      conceptModules: [],
      exclusive: false,
      from,
      importSites: null,
      measured: false,
      to,
    });
  };
  const center = proposed.semanticCenter;
  for (const pkg of span) {
    const responsibilities = responsibilitiesOf(proposed, pkg).filter(
      (responsibility) =>
        responsibility !== "consumption" &&
        responsibility !== "semantic-contract"
    );
    if (responsibilities.length === 0) {
      continue;
    }
    if (pkg !== center && center !== home) {
      needs(pkg, center);
    }
  }
  for (const [, move] of moves) {
    if (move.to !== undefined && move.to !== center) {
      needs(move.to, center);
    }
  }
  added.sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
  );
  return { added, current: currentEdges, states };
}

function dependencyImpact(plan: EdgePlan, home: string): DependencyImpact {
  const byLabel = new Map(
    plan.current.map((edge) => [edgeLabel(edge.from, edge.to), edge])
  );
  const removed: ScenarioDependencyEdge[] = [];
  const preserved: ScenarioDependencyEdge[] = [];
  const uncertain: ScenarioDependencyEdge[] = [];
  for (const state of plan.states) {
    const edge = byLabel.get(state.edge);
    if (edge === undefined) {
      continue;
    }
    if (state.outcome === "eliminated") {
      removed.push(edge);
    } else if (state.outcome === "uncertain") {
      uncertain.push(edge);
    } else {
      preserved.push(edge);
    }
  }
  const predicted = [...preserved, ...uncertain, ...plan.added].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
  );
  const fan = (pick: (edge: ScenarioDependencyEdge) => boolean) => {
    const current = plan.current.filter(pick).length;
    const gone = removed.filter(pick).length;
    const more = plan.added.filter(pick).length;
    const unknown = uncertain.filter(pick).length > 0;
    return metric(
      current,
      unknown ? null : current - gone + more,
      unknown ? "unknown" : gone + more > 0 ? "conditional" : "certain"
    );
  };
  return {
    added: plan.added,
    currentEdges: plan.current,
    packageFanInDelta: fan((edge) => edge.to === home),
    packageFanOutDelta: fan((edge) => edge.from === home),
    predictedEdges: predicted,
    preserved,
    removed,
    uncertain,
  };
}

function boundaryImpact(plan: EdgePlan): BoundaryImpact {
  const current = plan.states;
  const predicted: ScenarioBoundaryState[] = [
    ...plan.states
      .filter((state) => state.outcome !== "eliminated")
      .map((state) =>
        state.outcome === "reduced"
          ? {
              ...state,
              conceptImportSites:
                (state.conceptImportSites ?? 0) -
                (state.conceptImportSitesRemoved ?? 0),
              conceptImportSitesRemoved: 0,
              vacatedModules: [],
            }
          : state
      ),
    ...plan.added.map(
      (edge): ScenarioBoundaryState => ({
        certainty: "conditional",
        conceptImportSites: null,
        conceptImportSitesRemoved: null,
        conceptInteractionEnds: false,
        edge: edgeLabel(edge.from, edge.to),
        exclusive: false,
        from: edge.from,
        importSites: null,
        outcome: "added",
        remainingModules: [],
        to: edge.to,
        vacatedModules: [],
      })
    ),
  ].sort((a, b) => a.edge.localeCompare(b.edge));
  const measuredCurrent = current.filter((state) => state.importSites !== null);
  const currentSites = measuredCurrent.reduce(
    (sum, state) => sum + (state.conceptImportSites ?? 0),
    0
  );
  const removedSites = measuredCurrent.reduce(
    (sum, state) => sum + (state.conceptImportSitesRemoved ?? 0),
    0
  );
  const modulesCurrent = unique(
    measuredCurrent.flatMap((state) => [
      ...state.vacatedModules,
      ...state.remainingModules,
    ])
  ).length;
  const modulesPredicted = unique(
    measuredCurrent.flatMap((state) => state.remainingModules)
  ).length;
  const changed = removedSites > 0 || modulesPredicted !== modulesCurrent;
  return {
    added: plan.added.map((edge) => edgeLabel(edge.from, edge.to)),
    conceptModulesDelta: metric(
      modulesCurrent,
      modulesPredicted,
      changed ? "conditional" : "certain"
    ),
    current,
    eliminated: current
      .filter((state) => state.outcome === "eliminated")
      .map((state) => state.edge),
    importSitesDelta: metric(
      currentSites,
      currentSites - removedSites,
      changed ? "conditional" : "certain"
    ),
    predicted,
    preserved: current
      .filter((state) => state.outcome === "preserved")
      .map((state) => state.edge),
    reduced: current
      .filter((state) => state.outcome === "reduced")
      .map((state) => ({
        certainty: state.certainty,
        conceptImportSitesRemoved: state.conceptImportSitesRemoved ?? 0,
        conceptInteractionEnds: state.conceptInteractionEnds,
        edge: state.edge,
        remainingModules: state.remainingModules.length,
      })),
  };
}

function localityImpact(
  facts: ScenarioImpactFacts,
  behavior: BehaviorImpact,
  moves: Map<string, Relocation>,
  plan: EdgePlan,
  config: AnalysisConfig
): LocalityImpact {
  const currentPackages = behavior.currentByPackage
    .filter(holdsSourceBehavior)
    .map((row) => row.package)
    .sort();
  const predictedPackages = predictedSpan(behavior);
  const anyMove = moves.size > 0;
  const inSpan = new Set(predictedPackages);
  const remainingEdges = facts.edges.filter(
    (edge) => inSpan.has(edge.from) && inSpan.has(edge.to)
  ).length;
  const addedBehaviorEdges = plan.added.filter(
    (edge) => inSpan.has(edge.from) && inSpan.has(edge.to)
  ).length;
  const disconnected = facts.disconnectedPairs.filter(
    (pair) => inSpan.has(pair.left) && inSpan.has(pair.right)
  ).length;
  const from = facts.locality.shape;
  let to: BehavioralLocalityShape | undefined;
  let shapeCertainty: ImpactCertainty;
  if (!anyMove) {
    to = from;
    shapeCertainty = "certain";
  } else if (predictedPackages.length === 1) {
    const destination = predictedPackages[0];
    const modulesThere = facts.modules.filter(
      (row) => row.package === destination && !moves.has(row.module)
    ).length;
    if (
      modulesThere >=
      config.behavioralLocality.singlePackageDistributed.minModules
    ) {
      to = "single-package-distributed";
      shapeCertainty = "conditional";
    } else {
      shapeCertainty = "unknown";
    }
  } else {
    shapeCertainty = "unknown";
  }
  const current: LocalitySnapshot = {
    behavioralBoundaryEdges: facts.edges.length,
    disconnectedPackagePairs: facts.disconnectedPairs.length,
    maxTraversalDistance: facts.locality.maxModuleDistance,
    shape: from,
    sourceModuleCount: facts.locality.sourceModules,
    sourcePackageCount: currentPackages.length,
    sourcePackages: currentPackages,
  };
  const predicted: LocalitySnapshot = {
    behavioralBoundaryEdges: remainingEdges + addedBehaviorEdges,
    disconnectedPackagePairs: disconnected,
    maxTraversalDistance: anyMove ? null : facts.locality.maxModuleDistance,
    sourceModuleCount: anyMove ? null : facts.locality.sourceModules,
    sourcePackageCount: predictedPackages.length,
    sourcePackages: predictedPackages,
    ...(to !== undefined && { shape: to }),
  };
  return {
    behavioralBoundaryEdges: metric(
      current.behavioralBoundaryEdges,
      predicted.behavioralBoundaryEdges,
      addedBehaviorEdges > 0 ? "conditional" : "certain"
    ),
    current,
    disconnectedBehaviorPairs: metric(
      current.disconnectedPackagePairs,
      predicted.disconnectedPackagePairs,
      "certain"
    ),
    maxTraversalDistance: anyMove
      ? { certainty: "unknown", direction: "unknown" }
      : { certainty: "certain", direction: "unchanged" },
    predicted,
    shapeTransition: {
      from,
      ...(to !== undefined && { to }),
      certainty: shapeCertainty,
    },
    sourceModuleCount: metric(
      current.sourceModuleCount,
      predicted.sourceModuleCount,
      anyMove ? "unknown" : "certain"
    ),
    sourcePackageCount: metric(
      current.sourcePackageCount,
      predicted.sourcePackageCount,
      "certain"
    ),
  };
}

function surfaceImpact(
  facts: ScenarioImpactFacts,
  scenario: RecenteringScenario
): SurfaceImpact {
  const home = scenario.current.semanticCenter;
  const center = scenario.proposed.semanticCenter;
  const relocates = center !== home;
  const consumers = facts.scenario.referenceShares
    .filter((row) => row.package !== home && row.share > 0)
    .map((row) => row.package)
    .sort();
  const publicNow = facts.seed.packagePublic ? [home] : [];
  const publicNext = facts.seed.packagePublic ? [center] : [];
  const cautions: string[] = [];
  if (relocates && facts.seed.packagePublic) {
    cautions.push(
      "public contract relocation requires an exposure strategy; none is modeled"
    );
    cautions.push("surface transition unresolved");
  }
  if (scenario.kind === "split-responsibility") {
    cautions.push(
      "responsibility partition may need new contract surfaces; unknown"
    );
  }
  if (scenario.kind === "formalize-representation-boundary") {
    cautions.push("converter surface stays where it is; no new module modeled");
  }
  return {
    currentPublicPackages: publicNow,
    packagePublicContractRelocated: relocates && facts.seed.packagePublic,
    predictedPublicPackages: publicNext,
    publicExposureAdded: relocates
      ? publicNext.filter((pkg) => pkg !== home)
      : [],
    publicExposureRemoved: relocates ? publicNow : [],
    ...(relocates && { reexportRequirement: "unknown" as const }),
    consumers: {
      externallyUsed: facts.seed.externallyUsed,
      impact: relocates && consumers.length > 0 ? "unresolved" : "unaffected",
      packagePublic: facts.seed.packagePublic,
      packages: consumers,
    },
    surfaceCautions: cautions,
  };
}

function representationImpact(
  facts: ScenarioImpactFacts,
  scenario: RecenteringScenario
): RepresentationImpact {
  const { current, proposed } = scenario;
  const relocates = proposed.semanticCenter !== current.semanticCenter;
  const representationNow = packagesOf(current, "representation");
  const representationNext = relocates
    ? unique([
        ...packagesOf(proposed, "representation"),
        proposed.semanticCenter,
      ])
    : packagesOf(proposed, "representation");
  const persistenceNow = packagesOf(current, "persistence");
  const persistenceNext = packagesOf(proposed, "persistence");
  const conversionNow = packagesOf(current, "conversion");
  const conversionNext = packagesOf(proposed, "conversion");
  const changedConverters = unique([
    ...conversionNow.filter((pkg) => !conversionNext.includes(pkg)),
    ...conversionNext.filter((pkg) => !conversionNow.includes(pkg)),
  ]);
  return {
    certainty: relocates ? "conditional" : "certain",
    convertersPreserved: conversionNow.filter((pkg) =>
      conversionNext.includes(pkg)
    ),
    overlapPairsAffected: facts.scenario.boundaries
      .filter((boundary) =>
        boundary.converterPackages.some((pkg) =>
          changedConverters.includes(pkg)
        )
      )
      .map((boundary) => boundary.concept.name),
    persistenceRepresentationsPreserved: persistenceNow.filter((pkg) =>
      persistenceNext.includes(pkg)
    ),
    representationBoundariesAdded:
      scenario.kind === "formalize-representation-boundary"
        ? facts.scenario.boundaries.map((boundary) => boundary.concept.name)
        : [],
    representationBoundariesRemoved: [],
    semanticRepresentationsCurrent: representationNow,
    semanticRepresentationsPredicted: representationNext,
  };
}

function implementationImpact(
  scenario: RecenteringScenario
): ImplementationImpact {
  const now = packagesOf(scenario.current, "implementation");
  const next = packagesOf(scenario.proposed, "implementation");
  return {
    currentCenters: now,
    parallelImplementationPreserved: now.length >= 2 && sameSet(now, next),
    predictedCenters: next,
    preservedImplementations: now.filter((pkg) => next.includes(pkg)),
    relocatedImplementationResponsibility: now.filter(
      (pkg) => !next.includes(pkg)
    ),
  };
}

function evolutionImpact(
  facts: ScenarioImpactFacts,
  moves: Map<string, Relocation>
): EvolutionImpact {
  const placed = (module: string, pkg: string) => {
    const move = moves.get(module);
    return move === undefined ? pkg : move.to;
  };
  let preserved = 0;
  let coLocated = 0;
  let stillCross = 0;
  let unknown = 0;
  let newlyCross = 0;
  const coupledMoved = new Set<string>();
  for (const pair of facts.couplings) {
    const affected = moves.has(pair.left) || moves.has(pair.right);
    if (!affected) {
      preserved += 1;
      continue;
    }
    if (moves.has(pair.left)) {
      coupledMoved.add(pair.left);
    }
    if (moves.has(pair.right)) {
      coupledMoved.add(pair.right);
    }
    const left = placed(pair.left, pair.leftPackage);
    const right = placed(pair.right, pair.rightPackage);
    if (left === undefined || right === undefined) {
      unknown += 1;
    } else if (left === right) {
      if (pair.leftPackage === pair.rightPackage) {
        preserved += 1;
      } else {
        coLocated += 1;
      }
    } else {
      stillCross += 1;
      if (pair.leftPackage === pair.rightPackage) {
        newlyCross += 1;
      }
    }
  }
  const hotspots = new Set(facts.hotspotModules);
  const affectedPairs = coLocated + stillCross + unknown;
  return {
    couplingRelationshipsCoLocated: coLocated,
    couplingRelationshipsPreserved: preserved,
    couplingRelationshipsStillCrossBoundary: stillCross,
    couplingRelationshipsUnknown: unknown,
    historicalEvidenceAlignment: facts.historyAvailable
      ? affectedPairs === 0
        ? "unchanged"
        : coLocated > 0 && newlyCross === 0 && unknown === 0
          ? "improves"
          : "mixed"
      : "unknown",
    historicallyCoupledFilesAffected: coupledMoved.size,
    hotspotBehaviorRelocated: [...moves.keys()].filter((module) =>
      hotspots.has(module)
    ).length,
  };
}

function intentImpact(
  facts: ScenarioImpactFacts,
  scenario: RecenteringScenario
): IntentImpact {
  const { current, proposed } = scenario;
  const home = current.semanticCenter;
  const preserved: string[] = [];
  const violated: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const anchor of facts.scenario.anchors) {
    const pkg = anchor.package;
    const before = responsibilitiesOf(current, pkg);
    const after = responsibilitiesOf(proposed, pkg);
    if (before.length === 0 && after.length === 0) {
      continue;
    }
    if (pkg === home && proposed.semanticCenter !== home) {
      violated.push(pkg);
    }
    for (const responsibility of before) {
      if (!after.includes(responsibility)) {
        removed.push(`${pkg}: ${responsibility}`);
      }
    }
    for (const responsibility of after) {
      if (!before.includes(responsibility)) {
        added.push(`${pkg}: ${responsibility}`);
      }
    }
    if (before.join() === after.join()) {
      preserved.push(pkg);
    }
  }
  const publicChanges: string[] = [];
  if (proposed.semanticCenter !== home && facts.seed.packagePublic) {
    publicChanges.push(
      `package-public contract leaves ${home} for ${proposed.semanticCenter}`
    );
  }
  return {
    anchoredResponsibilitiesAdded: added.sort(),
    anchoredResponsibilitiesRemoved: removed.sort(),
    anchorsPreserved: preserved.sort(),
    anchorsViolated: violated.sort(),
    compatibility:
      scenario.status === "blocked" || violated.length > 0
        ? "incompatible"
        : added.length > 0 || removed.length > 0
          ? "constrained"
          : "compatible",
    publicBoundaryChanges: publicChanges,
  };
}

/**
 * Structural consequences of one V8.2 scenario against the current
 * placement. Pure over the derived facts: no scan, no history parse, no
 * graph recomputation. Every dimension is present for every scenario so a
 * later version can compare vectors; nothing here ranks, scores, or
 * recommends, and no file, import, or manifest change is predicted.
 */
export function simulateScenarioImpact(
  facts: ScenarioImpactFacts,
  scenario: RecenteringScenario,
  config: AnalysisConfig = ANALYSIS_CONFIG
): ScenarioImpactAnalysis {
  const { current, proposed } = scenario;
  const home = current.semanticCenter;
  const moves = relocations(facts, current, proposed);
  const behavior = behaviorImpact(facts, current, proposed);
  const span = predictedSpan(behavior);
  const plan = planEdges(facts, current, proposed, moves, span, config);
  const dependency = dependencyImpact(plan, home);
  const boundaries = boundaryImpact(plan);
  const locality = localityImpact(facts, behavior, moves, plan, config);
  const surface = surfaceImpact(facts, scenario);
  const representation = representationImpact(facts, scenario);
  const implementation = implementationImpact(scenario);
  const evolution = evolutionImpact(facts, moves);
  const intent = intentImpact(facts, scenario);

  const changes: ScenarioStructuralChange[] = [];
  const change = (
    kind: ScenarioStructuralChangeKind,
    certainty: ImpactCertainty,
    evidence: ScenarioStructuralChange["evidence"],
    from?: ScenarioStructuralChange["from"],
    to?: ScenarioStructuralChange["to"]
  ) =>
    changes.push({
      kind,
      ...(from !== undefined && { from }),
      ...(to !== undefined && { to }),
      certainty,
      evidence,
    });
  if (proposed.semanticCenter !== home) {
    change(
      "semantic-center-change",
      "certain",
      [
        {
          detail: "the scenario moves the semantic contract",
          source: "scenario",
        },
      ],
      home,
      proposed.semanticCenter
    );
    change(
      "surface-relocation",
      facts.seed.packagePublic ? "certain" : "conditional",
      [
        {
          detail: facts.seed.packagePublic
            ? `package-public seed in ${home}; exposure strategy unmodeled`
            : `seed is not package-public in ${home}`,
          source: "surface",
        },
      ],
      home,
      proposed.semanticCenter
    );
  }
  const behaviorNow = packagesOf(current, "domain-behavior");
  const behaviorNext = packagesOf(proposed, "domain-behavior");
  if (!sameSet(behaviorNow, behaviorNext)) {
    const relocates = behavior.governingBehaviorRelocated > 0;
    const kind: ScenarioStructuralChangeKind =
      relocates &&
      behaviorNext.length < behaviorNow.length &&
      behaviorNext.length === 1
        ? "behavior-consolidation"
        : "behavior-center-change";
    change(
      kind,
      behavior.certainty,
      [
        {
          detail: `domain behavior ${behaviorNow.join(", ")} → ${behaviorNext.join(", ")}`,
          source: "scenario",
        },
        relocates
          ? {
              detail: `source behavior packages ${locality.current.sourcePackageCount} → ${locality.predicted.sourcePackageCount}; ${behavior.governingBehaviorRelocated} governing behavior(s) relocate, ${behavior.consumerBehaviorUnaffected} consumer behavior(s) stay`,
              source: "concept-locality",
            }
          : {
              detail:
                "reclassification only: conversion-only behavior reads as conversion responsibility; nothing relocates",
              source: "scenario",
            },
      ],
      behaviorNow,
      behaviorNext
    );
  }
  for (const state of plan.states) {
    if (state.outcome === "eliminated") {
      change(
        "boundary-elimination",
        state.certainty,
        [
          {
            detail: `${state.vacatedModules.length} concept module(s) leave the edge; ${state.conceptImportSitesRemoved ?? 0} concept import site(s) of ${state.importSites ?? 0}`,
            source: "boundary-interaction",
          },
        ],
        state.edge
      );
      change(
        "dependency-elimination",
        "conditional",
        [
          {
            detail:
              "every import site on the edge names a concept module, at module granularity",
            source: "boundary-interaction",
          },
        ],
        state.edge
      );
    } else if (state.outcome === "reduced") {
      change(
        "boundary-reduction",
        state.certainty,
        [
          {
            detail: state.conceptInteractionEnds
              ? `the concept stops crossing the edge (${state.conceptImportSitesRemoved ?? 0} of ${state.importSites ?? 0} import sites); unrelated traffic keeps it`
              : `${state.vacatedModules.length} concept module(s) leave the edge, ${state.remainingModules.length} remain; ${state.conceptImportSitesRemoved ?? 0} concept import site(s) of ${state.importSites ?? 0} removed`,
            source: "boundary-interaction",
          },
        ],
        state.edge
      );
    }
  }
  for (const edge of plan.added) {
    const label = edgeLabel(edge.from, edge.to);
    change(
      "boundary-addition",
      "conditional",
      [
        {
          detail: `${edge.from} would hold responsibility for a contract in ${edge.to} without a current concept edge`,
          source: "scenario",
        },
      ],
      undefined,
      label
    );
    change(
      "dependency-addition",
      "conditional",
      [
        {
          detail:
            "no current package edge between them is known to the concept",
          source: "scenario",
        },
      ],
      undefined,
      label
    );
  }
  if (
    facts.scenario.boundaries.length > 0 &&
    representation.overlapPairsAffected.length === 0
  ) {
    change(
      "representation-boundary-preserved",
      "certain",
      facts.scenario.boundaries.map((boundary) => ({
        detail: `${boundary.concept.name} converts in ${boundary.converterPackages.join(", ")}`,
        source: "concept-overlap" as const,
      })),
      facts.scenario.boundaries.map((boundary) => boundary.concept.name)
    );
  }
  if (representation.representationBoundariesAdded.length > 0) {
    change(
      "representation-boundary-added",
      "certain",
      [
        {
          detail:
            "semantic and stored representations become explicitly separated; converter responsibility stays put; no new type or module is modeled",
          source: "scenario",
        },
      ],
      undefined,
      representation.representationBoundariesAdded
    );
  }
  if (implementation.parallelImplementationPreserved) {
    change(
      "implementation-split-preserved",
      "certain",
      [
        {
          detail: `${implementation.currentCenters.length} implementation centers unchanged`,
          source: "concept-ownership",
        },
      ],
      implementation.currentCenters
    );
  }
  if (
    intent.anchorsViolated.length > 0 ||
    intent.anchoredResponsibilitiesAdded.length > 0 ||
    intent.anchoredResponsibilitiesRemoved.length > 0
  ) {
    change("anchor-constraint", "certain", [
      {
        detail: [
          ...intent.anchorsViolated.map(
            (pkg) => `${pkg} loses the semantic contract`
          ),
          ...intent.anchoredResponsibilitiesAdded.map((row) => `gains ${row}`),
          ...intent.anchoredResponsibilitiesRemoved.map(
            (row) => `loses ${row}`
          ),
        ].join("; "),
        source: "anchor",
      },
    ]);
  }
  changes.sort(
    (a, b) =>
      CHANGE_ORDER.indexOf(a.kind) - CHANGE_ORDER.indexOf(b.kind) ||
      String(a.from ?? "").localeCompare(String(b.from ?? "")) ||
      String(a.to ?? "").localeCompare(String(b.to ?? ""))
  );

  const preserved: ScenarioPreservation[] = [];
  if (proposed.semanticCenter === home) {
    preserved.push({ detail: home, kind: "semantic-center" });
  }
  if (implementation.parallelImplementationPreserved) {
    preserved.push({
      detail: implementation.currentCenters.join(", "),
      kind: "implementation-split",
    });
  }
  for (const boundary of facts.scenario.boundaries) {
    if (
      boundary.persistenceLike &&
      representation.persistenceRepresentationsPreserved.includes(
        boundary.package
      )
    ) {
      preserved.push({
        detail: `${boundary.concept.name} in ${boundary.package}`,
        kind: "persistence-boundary",
      });
    }
  }
  for (const pkg of intent.anchorsPreserved) {
    preserved.push({ detail: pkg, kind: "anchor" });
  }
  if (proposed.semanticCenter === home && facts.seed.packagePublic) {
    preserved.push({ detail: home, kind: "public-contract" });
  }
  if (surface.consumers.packages.length > 0) {
    preserved.push({
      detail: `${surface.consumers.packages.join(", ")} keep referencing the concept where they are`,
      kind: "consumer-boundary",
    });
  }

  const uncertainties: ScenarioImpactUncertainty[] = [];
  if (moves.size > 0) {
    uncertainties.push({
      detail: `${moves.size} module(s) would carry responsibility; the scenario names packages, not modules`,
      kind: "target-module-unknown",
    });
  }
  if (surface.consumers.impact === "unresolved") {
    uncertainties.push({
      detail: `${surface.consumers.packages.length} consuming package(s) import a contract that moves; whether they change is unresolved`,
      kind: "consumer-compatibility-unknown",
    });
  }
  if (facts.scenario.unobservedConformance) {
    uncertainties.push({
      detail:
        "implementations conforming structurally would change implementation and locality dimensions",
      kind: "structural-conformance-unobserved",
    });
  }
  for (const row of facts.scenario.behavior) {
    if (row.construction === 0) {
      continue;
    }
    const vacated =
      packagesOf(current, "domain-behavior").includes(row.package) &&
      !packagesOf(proposed, "domain-behavior").includes(row.package);
    if (vacated) {
      uncertainties.push({
        detail: `${row.package} still constructs the concept ${row.construction} time(s); its wiring edge stays`,
        kind: "composition-root-remains",
      });
    }
  }
  const sharedEdges = plan.states.filter(
    (state) => state.outcome === "reduced" || state.outcome === "uncertain"
  );
  if (sharedEdges.length > 0) {
    uncertainties.push({
      detail: sharedEdges
        .map((state) => `${state.edge} (${state.outcome})`)
        .join("; "),
      kind: "shared-boundary-edge",
    });
  }
  if (surface.packagePublicContractRelocated) {
    uncertainties.push({
      detail: "re-export, consumer migration, or facade is not chosen here",
      kind: "surface-transition-unspecified",
    });
  }
  if (evolution.couplingRelationshipsCoLocated > 0) {
    uncertainties.push({
      detail:
        "co-location describes past co-change under the proposed placement, not future churn",
      kind: "historical-future-assumption",
    });
  }

  const constraints: ScenarioConstraintImpact[] = scenario.constraints.map(
    (constraint) => ({
      consequence:
        constraint.kind === "anchor"
          ? constraint.package === home && proposed.semanticCenter !== home
            ? `the semantic contract cannot leave ${home}; simulated as a counterfactual`
            : `${constraint.package} cannot be assumed to give up or absorb responsibility`
          : constraint.kind === "public-contract"
            ? "relocating the contract needs an exposure strategy; consumers unresolved"
            : constraint.kind === "representation-boundary"
              ? `converters for ${constraint.concepts.join(", ")} stay where they are`
              : "implementation and locality dimensions are partially simulated",
      constraint,
    })
  );

  // Unresolved consumer edges are the expected answer under a contract
  // move (§53), not a simulation gap; missing evidence is.
  const status: ScenarioImpactAnalysis["status"] =
    scenario.status === "blocked"
      ? "blocked"
      : facts.scenario.unobservedConformance ||
          plan.states.some(
            (state) =>
              state.outcome === "uncertain" && state.importSites === null
          )
        ? "partially-simulated"
        : "simulated";

  const count = (certainty: ImpactCertainty) =>
    changes.filter((item) => item.certainty === certainty).length;

  const summary: string[] = [];
  if (scenario.kind === "preserve-current") {
    summary.push(
      "no placement delta; current structure retained as the baseline"
    );
  }
  if (proposed.semanticCenter !== home) {
    summary.push(
      `semantic contract ${home} → ${proposed.semanticCenter} (certain)`
    );
  }
  if (locality.sourcePackageCount.delta !== 0) {
    summary.push(
      `source behavior packages ${locality.current.sourcePackageCount} → ${locality.predicted.sourcePackageCount} (certain)`
    );
  }
  if (behavior.governingBehaviorRelocated > 0) {
    summary.push(
      `${behavior.governingBehaviorRelocated} governing behavior(s) relocate; ${behavior.consumerBehaviorUnaffected} consumer behavior(s) stay`
    );
  }
  for (const edge of boundaries.eliminated) {
    summary.push(`boundary ${edge} eliminated (conditional)`);
  }
  for (const row of boundaries.reduced) {
    summary.push(
      row.conceptInteractionEnds
        ? `boundary ${row.edge} reduced: the concept stops crossing it, unrelated traffic remains (conditional)`
        : `boundary ${row.edge} reduced: ${row.conceptImportSitesRemoved} concept import site(s) removed, ${row.remainingModules} concept module(s) remain (conditional)`
    );
  }
  for (const edge of boundaries.added) {
    summary.push(`boundary ${edge} added (conditional)`);
  }
  if (
    locality.disconnectedBehaviorPairs.delta !== null &&
    locality.disconnectedBehaviorPairs.delta < 0
  ) {
    summary.push(
      `disconnected behavior package pairs ${locality.current.disconnectedPackagePairs} → ${locality.predicted.disconnectedPackagePairs} (certain)`
    );
  }
  if (surface.consumers.packages.length > 0) {
    summary.push(
      `consumers in ${surface.consumers.packages.join(", ")} ${surface.consumers.impact}`
    );
  }
  if (surface.packagePublicContractRelocated) {
    summary.push("public surface transition unresolved");
  }
  if (implementation.parallelImplementationPreserved) {
    summary.push("parallel implementations preserved");
  }
  for (const item of preserved) {
    if (item.kind === "persistence-boundary") {
      summary.push(`persistence boundary preserved: ${item.detail}`);
    }
  }
  if (evolution.couplingRelationshipsCoLocated > 0) {
    summary.push(
      `${evolution.couplingRelationshipsCoLocated} historically coupled pair(s) would become co-located`
    );
  }
  if (evolution.hotspotBehaviorRelocated > 0) {
    summary.push(
      `${evolution.hotspotBehaviorRelocated} hotspot module(s) affected; local complexity unchanged`
    );
  }
  summary.push(`intent ${intent.compatibility}`);

  return {
    baseline: current,
    certainty: {
      certain: count("certain"),
      conditional: count("conditional"),
      unknown: count("unknown") + uncertainties.length,
    },
    changes,
    concept: scenario.subject,
    constraints,
    findingId: scenario.findingId,
    impact: {
      behavior,
      boundaries,
      dependency,
      evolution,
      implementation,
      intent,
      locality,
      representation,
      surface,
    },
    kind: scenario.kind,
    preserved,
    proposed,
    scenarioId: scenario.id,
    status,
    summary,
    uncertainties,
  };
}

/** V8.2 scenarios, the V8.1 findings they answer, and the V8.0 facts both were derived from. */
export interface ScenarioImpactSource {
  facts: RecenteringFacts[];
  miscentered: MiscenteredConceptReport;
  scenarios: RecenteringScenarioReport;
}

/** Impact of every V8.2 scenario, in scenario order. Compositional; no rescan. */
export function analyzeScenarioImpacts(
  source: ScenarioImpactSource,
  config: AnalysisConfig = ANALYSIS_CONFIG
): ScenarioImpactReport {
  const started = performance.now();
  const factsById = new Map(
    source.facts.map((item) => [item.concept.id, item])
  );
  const findingsById = new Map(
    source.miscentered.findings.map((item) => [item.id, item])
  );
  const findings: ScenarioImpactFinding[] = [];
  for (const finding of source.scenarios.findings) {
    const facts = factsById.get(finding.findingId);
    const miscentered = findingsById.get(finding.findingId);
    if (facts === undefined || miscentered === undefined) {
      throw new Error(`re-centering facts missing for ${finding.subject.name}`);
    }
    const derived = deriveScenarioImpactFacts(miscentered, facts, config);
    findings.push({
      findingId: finding.findingId,
      scenarios: finding.scenarios.map((scenario) =>
        simulateScenarioImpact(derived, scenario, config)
      ),
      subject: finding.subject,
    });
  }
  return {
    findings,
    summary: summarize(findings, performance.now() - started),
    target: source.scenarios.target,
  };
}

function summarize(
  findings: ScenarioImpactFinding[],
  runtimeMs: number
): ScenarioImpactSummary {
  const all = findings.flatMap((finding) => finding.scenarios);
  const status = (value: ScenarioImpactAnalysis["status"]) =>
    all.filter((item) => item.status === value).length;
  const sum = (pick: (item: ScenarioImpactAnalysis) => number) =>
    all.reduce((total, item) => total + pick(item), 0);
  return {
    anchorConflicts: all.filter(
      (item) => item.impact.intent.compatibility === "incompatible"
    ).length,
    blocked: status("blocked"),
    boundaryAdditions: sum((item) => item.impact.boundaries.added.length),
    boundaryEliminations: sum(
      (item) => item.impact.boundaries.eliminated.length
    ),
    boundaryReductions: sum((item) => item.impact.boundaries.reduced.length),
    certainChanges: sum((item) => item.certainty.certain),
    conditionalChanges: sum((item) => item.certainty.conditional),
    dependencyEliminations: sum(
      (item) => item.impact.dependency.removed.length
    ),
    localityDecreases: all.filter(
      (item) => (item.impact.locality.sourcePackageCount.delta ?? 0) < 0
    ).length,
    localityIncreases: all.filter(
      (item) => (item.impact.locality.sourcePackageCount.delta ?? 0) > 0
    ).length,
    partiallySimulated: status("partially-simulated"),
    representationBoundariesPreserved: sum(
      (item) =>
        item.preserved.filter((row) => row.kind === "persistence-boundary")
          .length
    ),
    runtimeMs: Math.round(runtimeMs * 100) / 100,
    scenarios: all.length,
    simulated: status("simulated"),
    surfaceRelocations: all.filter(
      (item) => item.impact.surface.packagePublicContractRelocated
    ).length,
    unknownConsequences: sum((item) => item.certainty.unknown),
  };
}
