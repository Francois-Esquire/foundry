import { classifyFile } from "./churn";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type { GravityBoundary } from "./gravity";
import { workspacePackages } from "./gravity";
import type {
  BehavioralLocalityCaution,
  BehavioralLocalityModifier,
  BehavioralLocalityShape,
  BehaviorRole,
  ChurnFileKind,
  ConceptBehavioralLocality,
  ConceptBehavioralLocalityReport,
  ConceptBehaviorCoupling,
  ConceptBehaviorMap,
  ConceptBehaviorModule,
  ConceptBehaviorPackage,
  ConceptBehaviorParticipant,
  ConceptBehaviorSpan,
  ConceptBehaviorTemporalContext,
  ConceptDistance,
  ConceptExternalCompanion,
  ConceptTraversalContext,
  FileChangeCouplingPair,
  ModuleRole,
  SurfaceReport,
  WorkspaceModuleGraph,
} from "./types";

export interface ConceptBehavioralLocalitySource
  extends Pick<
    SurfaceReport,
    | "conceptInventory"
    | "conceptOverlap"
    | "conceptOwnership"
    | "dependencyGravity"
    | "changeCoupling"
    | "hotspots"
  > {
  anchor?: SurfaceReport["anchor"];
  boundary: GravityBoundary;
  graph: WorkspaceModuleGraph;
}

/** Everything the shape rules and cautions read; the measurements come from `analyzeConceptBehavioralLocality`. */
export interface LocalityFacts
  extends Omit<ConceptBehavioralLocality, "shape" | "cautions"> {
  /** V7.3 found a method-bearing interface with no explicit implementation. */
  contractWithoutImplementations: boolean;
  /** Some source behavior lives outside the target, where churn and hotspots are not measured. */
  foreignSourceBehavior: boolean;
}

function share(part: number, total: number): number | null {
  return total === 0 ? null : part / total;
}

/** Shape and cautions from measured facts. Counts and distances only; no score. */
export function assessLocality(
  facts: LocalityFacts,
  config: AnalysisConfig = ANALYSIS_CONFIG
): ConceptBehavioralLocality {
  const policy = config.behavioralLocality;
  const { behavior, span, traversal, halo } = facts;
  const source = behavior.source;
  // A class seed's own members are not attributed as behavior (V7.3 counts
  // members of implementing classes only), so little behavior on a class
  // says nothing about how light it is.
  const broad =
    facts.concept.kind !== "class" &&
    halo.modules >= policy.behaviorLight.minReferenceModules;

  let primary: BehavioralLocalityShape;
  if (source < policy.support.minSourceBehaviors) {
    primary = broad ? "behavior-light" : "insufficient-evidence";
  } else if (source <= policy.behaviorLight.maxSourceBehaviors && broad) {
    primary = "behavior-light";
  } else if (span.sourcePackageCount <= 1) {
    primary =
      span.sourceModuleCount >= policy.singlePackageDistributed.minModules
        ? "single-package-distributed"
        : "local";
  } else {
    const gate = policy.crossPackageDistributed;
    const breadth =
      (traversal.maxModuleDistance ?? 0) >= gate.minTraversalDistance ||
      traversal.disconnectedPackagePairs > 0 ||
      traversal.disconnectedModules > 0;
    primary =
      span.sourceModuleCount >= gate.minModules &&
      (span.sourcePackageCount >= gate.minPackages || breadth)
        ? "cross-package-distributed"
        : "cross-package-localized";
  }

  const modifiers: BehavioralLocalityModifier[] = [];
  const implementationPackages = new Set(
    behavior.byModule
      .filter((row) => row.kind === "source" && row.implementationBehaviors > 0)
      .map((row) => row.package)
  );
  if (
    implementationPackages.size >= policy.parallelImplementations.minPackages
  ) {
    modifiers.push("parallel-implementations");
  }

  const cautions: BehavioralLocalityCaution[] = [];
  if (facts.contractWithoutImplementations) {
    cautions.push({
      detail:
        "explicit behavior only; structural object-conformance implementations may be missing",
      kind: "structural-conformance-unobserved",
    });
  }
  const contextual = behavior.test + behavior.story;
  if (contextual > 0 && contextual > source) {
    cautions.push({
      detail: `${contextual} test/story behaviors beside ${source} source; the shape reads source only`,
      kind: "test-heavy-behavior",
    });
  }
  // A one-function `local` is trivially local; sparseness matters only
  // where the shape claims spread.
  const claimsSpread =
    primary === "single-package-distributed" ||
    primary === "cross-package-localized" ||
    primary === "cross-package-distributed";
  if (claimsSpread && source < policy.support.sparseSourceBehaviors) {
    cautions.push({
      detail: `${source} source behaviors; below ${policy.support.sparseSourceBehaviors} the shape rests on little`,
      kind: "sparse-source-behavior",
    });
  }
  if (
    traversal.disconnectedPackagePairs > 0 ||
    traversal.disconnectedModules > 0
  ) {
    const parts: string[] = [];
    if (traversal.disconnectedPackagePairs > 0) {
      parts.push(
        `${traversal.disconnectedPackagePairs} behavior package pairs reach neither way`
      );
    }
    if (traversal.disconnectedModules > 0) {
      parts.push(
        `${traversal.disconnectedModules} source modules with no static path to the seed module`
      );
    }
    cautions.push({
      detail: parts.join("; "),
      kind: "disconnected-static-path",
    });
  }
  if (facts.temporal !== undefined && facts.foreignSourceBehavior) {
    cautions.push({
      detail:
        "churn and hotspots cover the target only; foreign behavior modules show coupling at most",
      kind: "target-scoped-history",
    });
  }

  const {
    contractWithoutImplementations: _contract,
    foreignSourceBehavior: _foreign,
    ...measured
  } = facts;
  return { ...measured, cautions, shape: { modifiers, primary } };
}

interface Reach {
  distance: number;
  viaAggregator: boolean;
}

/** Memoized single-source shortest paths in the dependency direction. */
class Distances {
  private readonly memo = new Map<string, Map<string, Reach>>();

  constructor(
    private readonly out: Map<string, Set<string>>,
    private readonly aggregators: Set<string>
  ) {}

  between(from: string, to: string): Reach | undefined {
    return this.from(from).get(to);
  }

  private from(start: string): Map<string, Reach> {
    const cached = this.memo.get(start);
    if (cached !== undefined) {
      return cached;
    }
    const reach = new Map<string, Reach>([
      [start, { distance: 0, viaAggregator: false }],
    ]);
    const queue = [start];
    // for-of sees elements appended during iteration, so this drains the queue
    for (const current of queue) {
      const own = reach.get(current);
      if (own === undefined) {
        continue;
      }
      const via =
        own.viaAggregator ||
        (current !== start && this.aggregators.has(current));
      for (const next of this.out.get(current) ?? []) {
        if (reach.has(next)) {
          continue;
        }
        reach.set(next, { distance: own.distance + 1, viaAggregator: via });
        queue.push(next);
      }
    }
    reach.delete(start);
    this.memo.set(start, reach);
    return reach;
  }
}

function adjacencyOf(
  edges: Iterable<[string, string]>
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [from, to] of edges) {
    if (from === to) {
      continue;
    }
    let targets = out.get(from);
    if (targets === undefined) {
      targets = new Set();
      out.set(from, targets);
    }
    targets.add(to);
  }
  return out;
}

function distance(
  graph: Distances,
  from: string,
  to: string,
  withAggregator: boolean
): ConceptDistance {
  const outward = graph.between(from, to);
  const inward = graph.between(to, from);
  return {
    from,
    to,
    ...(outward !== undefined && { outward: outward.distance }),
    ...(inward !== undefined && { inward: inward.distance }),
    ...(withAggregator && {
      viaAggregator:
        (outward?.viaAggregator ?? false) || (inward?.viaAggregator ?? false),
    }),
  };
}

function nearest(item: ConceptDistance): number | undefined {
  if (item.outward === undefined) {
    return item.inward;
  }
  if (item.inward === undefined) {
    return item.outward;
  }
  return Math.min(item.outward, item.inward);
}

function farthest(items: ConceptDistance[]): number | null {
  let max: number | null = null;
  for (const item of items) {
    const value = nearest(item);
    if (value !== undefined && (max === null || value > max)) {
      max = value;
    }
  }
  return max;
}

function disconnected(items: ConceptDistance[]): number {
  return items.filter((item) => nearest(item) === undefined).length;
}

interface StaticIndex {
  modules: Distances;
  packageEdges: Set<string>;
  packageOf: Map<string, string>;
  packages: Distances;
  roles: Map<string, ModuleRole["kind"]>;
}

const EDGE = " -> ";

function measureTraversal(
  origin: ConceptTraversalContext["origin"],
  sourceModules: string[],
  sourcePackages: string[],
  index: StaticIndex
): {
  traversal: ConceptTraversalContext;
  span: ConceptBehaviorSpan["boundaryEdges"];
} {
  const centerDistances = sourcePackages
    .filter((pkg) => pkg !== origin.package)
    .map((pkg) => distance(index.packages, origin.package, pkg, false));
  const packageDistances: ConceptDistance[] = [];
  for (let i = 0; i < sourcePackages.length; i += 1) {
    for (let j = i + 1; j < sourcePackages.length; j += 1) {
      const from = sourcePackages[i];
      const to = sourcePackages[j];
      if (from === undefined || to === undefined) {
        continue;
      }
      packageDistances.push(distance(index.packages, from, to, false));
    }
  }
  const moduleDistances = sourceModules
    .filter((module) => module !== origin.module)
    .map((module) => distance(index.modules, origin.module, module, true));
  const boundaryEdges: ConceptBehaviorSpan["boundaryEdges"] = [];
  for (const from of sourcePackages) {
    for (const to of sourcePackages) {
      if (from !== to && index.packageEdges.has(`${from}${EDGE}${to}`)) {
        boundaryEdges.push({ from, to });
      }
    }
  }
  return {
    span: boundaryEdges,
    traversal: {
      centerDistances,
      disconnectedModules: disconnected(moduleDistances),
      disconnectedPackagePairs: disconnected(packageDistances),
      maxModuleDistance: farthest(moduleDistances),
      maxPackageDistance: farthest(packageDistances),
      moduleDistances,
      origin,
      packageDistances,
      participatingModules: sourceModules,
      participatingPackages: sourcePackages,
    },
  };
}

interface TaggedParticipant extends ConceptBehaviorParticipant {
  roles: BehaviorRole[];
}

function behaviorMap(
  participants: TaggedParticipant[],
  roles: Map<string, ModuleRole["kind"]>
): ConceptBehaviorMap {
  const modules = new Map<string, ConceptBehaviorModule>();
  const counts: Record<ChurnFileKind, number> = {
    config: 0,
    other: 0,
    source: 0,
    story: 0,
    test: 0,
  };
  for (const item of participants) {
    counts[item.kind] += 1;
    let row = modules.get(item.file);
    if (row === undefined) {
      const role = roles.get(item.file);
      row = {
        behaviors: 0,
        contractBehaviors: 0,
        conversionBehaviors: 0,
        implementationBehaviors: 0,
        kind: item.kind,
        module: item.file,
        package: item.package,
        ...(role !== undefined && { role }),
      };
      modules.set(item.file, row);
    }
    row.behaviors += 1;
    if (item.roles.includes("contract")) {
      row.contractBehaviors += 1;
    }
    if (item.roles.includes("implementation")) {
      row.implementationBehaviors += 1;
    }
    if (item.roles.includes("conversion")) {
      row.conversionBehaviors += 1;
    }
  }
  const byModule = [...modules.values()].sort((a, b) =>
    a.module.localeCompare(b.module)
  );
  const packages = new Map<string, ConceptBehaviorPackage>();
  for (const row of byModule) {
    let pkg = packages.get(row.package);
    if (pkg === undefined) {
      pkg = {
        behaviors: 0,
        contractBehaviors: 0,
        conversionBehaviors: 0,
        implementationBehaviors: 0,
        modules: 0,
        package: row.package,
        sourceBehaviors: 0,
        sourceModules: 0,
        storyBehaviors: 0,
        testBehaviors: 0,
      };
      packages.set(row.package, pkg);
    }
    pkg.behaviors += row.behaviors;
    pkg.contractBehaviors += row.contractBehaviors;
    pkg.implementationBehaviors += row.implementationBehaviors;
    pkg.conversionBehaviors += row.conversionBehaviors;
    pkg.modules += 1;
    if (row.kind === "source") {
      pkg.sourceBehaviors += row.behaviors;
      pkg.sourceModules += 1;
    } else if (row.kind === "test") {
      pkg.testBehaviors += row.behaviors;
    } else if (row.kind === "story") {
      pkg.storyBehaviors += row.behaviors;
    }
  }
  return {
    byModule,
    byPackage: [...packages.values()].sort(
      (a, b) => b.behaviors - a.behaviors || a.package.localeCompare(b.package)
    ),
    other: counts.config + counts.other,
    source: counts.source,
    story: counts.story,
    test: counts.test,
    total: participants.length,
  };
}

function primary(rows: { name: string; share: number | null }[]): {
  name?: string;
  share: number | null;
} {
  const best = [...rows]
    .filter((row) => row.share !== null && row.share > 0)
    .sort(
      (a, b) => (b.share ?? 0) - (a.share ?? 0) || a.name.localeCompare(b.name)
    )[0];
  return best === undefined
    ? { share: null }
    : { name: best.name, share: best.share };
}

interface TemporalIndex {
  aggregators: Set<string>;
  hotspots: Map<string, { commits: number; commitPercentile: number }>;
  packageOf: Map<string, string>;
  pairsByFile: Map<string, FileChangeCouplingPair[]>;
}

function temporalOf(
  modules: Set<string>,
  index: TemporalIndex
): ConceptBehaviorTemporalContext {
  const hotspots: ConceptBehaviorTemporalContext["hotspots"] = [];
  const internal = new Map<string, ConceptBehaviorCoupling>();
  const external: ConceptExternalCompanion[] = [];
  for (const module of [...modules].sort()) {
    const hotspot = index.hotspots.get(module);
    if (hotspot !== undefined) {
      hotspots.push({ module, ...hotspot });
    }
    for (const pair of index.pairsByFile.get(module) ?? []) {
      const partner = pair.left === module ? pair.right : pair.left;
      if (modules.has(partner)) {
        internal.set(`${pair.left}${EDGE}${pair.right}`, {
          aggregatorMediated:
            index.aggregators.has(pair.left) ||
            index.aggregators.has(pair.right),
          coChangeCommits: pair.coChangeCommits,
          context: pair.context,
          jaccard: pair.jaccard,
          left: pair.left,
          leftConditional: pair.leftConditional,
          right: pair.right,
          rightConditional: pair.rightConditional,
          staticPath: pair.staticPath,
        });
      } else {
        external.push({
          coChangeCommits: pair.coChangeCommits,
          context: pair.context,
          external: partner,
          externalPackage: index.packageOf.get(partner) ?? "<root>",
          module,
        });
      }
    }
  }
  return {
    externalCompanions: external.sort(
      (a, b) =>
        b.coChangeCommits - a.coChangeCommits ||
        a.module.localeCompare(b.module) ||
        a.external.localeCompare(b.external)
    ),
    hotspots,
    internalCouplings: [...internal.values()].sort(
      (a, b) =>
        b.coChangeCommits - a.coChangeCommits ||
        a.left.localeCompare(b.left) ||
        a.right.localeCompare(b.right)
    ),
  };
}

/**
 * Behavioral locality of every family. Composes V7.3 participants, V7.2
 * converters, the workspace module graph, and V6 history; the only new
 * work is shortest paths between participating modules and packages,
 * memoized per start node across concepts.
 */
export function analyzeConceptBehavioralLocality(
  source: ConceptBehavioralLocalitySource,
  config: AnalysisConfig = ANALYSIS_CONFIG
): ConceptBehavioralLocalityReport {
  const { packageOf, moduleEdges } = workspacePackages(
    source.graph,
    source.boundary
  );
  const roles = new Map<string, ModuleRole["kind"]>();
  for (const module of source.dependencyGravity.modules) {
    if (module.role !== undefined) {
      roles.set(module.node.id, module.role.kind);
    }
  }
  const aggregators = new Set(
    [...roles].filter(([, kind]) => kind === "aggregator").map(([file]) => file)
  );
  const packageEdges = new Set<string>();
  for (const edge of moduleEdges) {
    const from = packageOf.get(edge.fromFile);
    const to = packageOf.get(edge.toFile);
    if (from !== undefined && to !== undefined && from !== to) {
      packageEdges.add(`${from}${EDGE}${to}`);
    }
  }
  const index: StaticIndex = {
    modules: new Distances(
      adjacencyOf(moduleEdges.map((edge) => [edge.fromFile, edge.toFile])),
      aggregators
    ),
    packageEdges,
    packageOf,
    packages: new Distances(
      adjacencyOf(
        [...packageEdges].map((key) => key.split(EDGE) as [string, string])
      ),
      new Set()
    ),
    roles,
  };

  let temporal: TemporalIndex | undefined;
  if (source.changeCoupling.available && source.hotspots.available) {
    const pairsByFile: TemporalIndex["pairsByFile"] = new Map();
    for (const pair of source.changeCoupling.filePairs) {
      for (const file of [pair.left, pair.right]) {
        const list = pairsByFile.get(file);
        if (list === undefined) {
          pairsByFile.set(file, [pair]);
        } else {
          list.push(pair);
        }
      }
    }
    temporal = {
      aggregators,
      hotspots: new Map(
        source.hotspots.files.map((file) => [
          file.file,
          {
            commitPercentile: file.evolution.commitPercentile,
            commits: file.evolution.commits,
          },
        ])
      ),
      packageOf,
      pairsByFile,
    };
  }

  const conversionsBySeed = new Map<
    string,
    { function: string; file: string }[]
  >();
  for (const candidate of source.conceptOverlap.candidates) {
    for (const side of [candidate.left, candidate.right]) {
      if (!side.inTarget) {
        continue;
      }
      const list = conversionsBySeed.get(side.id) ?? [];
      list.push(...candidate.conversions);
      conversionsBySeed.set(side.id, list);
    }
  }
  const ownershipBySeed = new Map(
    source.conceptOwnership.concepts.map((item) => [item.concept.id, item])
  );
  const targetName = source.boundary.packageName ?? source.boundary.relPath;

  const concepts = source.conceptInventory.families.map((family) => {
    const ownership = ownershipBySeed.get(family.seed.id);
    const analysis = family.distributionAnalysis;
    if (ownership === undefined || analysis === undefined) {
      throw new Error(
        `concept ownership is not attached for ${family.seed.name}`
      );
    }
    const participants: TaggedParticipant[] =
      ownership.behavior.participants.map((item) => ({
        ...item,
        roles: [item.role],
      }));
    // One function converting to two partners is still one participant.
    // A converter V7.3 did not attribute (its signature wraps the concept in
    // a Promise or array, which V7.2 looks through) joins as one.
    for (const conversion of conversionsBySeed.get(family.seed.id) ?? []) {
      const match = participants.find(
        (item) =>
          item.file === conversion.file && item.symbol === conversion.function
      );
      if (match !== undefined) {
        if (!match.roles.includes("conversion")) {
          match.roles.push("conversion");
        }
        continue;
      }
      const pkg = packageOf.get(conversion.file);
      participants.push({
        file: conversion.file,
        kind: classifyFile(conversion.file),
        member: "function",
        package: pkg ?? "<root>",
        role: "contract",
        roles: ["contract", "conversion"],
        symbol: conversion.function,
      });
    }
    const behavior = behaviorMap(participants, roles);
    const sourceRows = behavior.byModule.filter((row) => row.kind === "source");
    const sourceModules = sourceRows.map((row) => row.module);
    const sourcePackages = [
      ...new Set(sourceRows.map((row) => row.package)),
    ].sort();
    const origin = {
      module: family.seed.declaration.file,
      package: family.seed.declaration.package,
    };
    const { traversal, span: boundaryEdges } = measureTraversal(
      origin,
      sourceModules,
      sourcePackages,
      index
    );
    const modules = new Set(behavior.byModule.map((row) => row.module));
    const temporalContext =
      temporal === undefined ? undefined : temporalOf(modules, temporal);
    const coupled = new Set(
      (temporalContext?.internalCouplings ?? []).flatMap((pair) => [
        pair.left,
        pair.right,
      ])
    );
    const hotspotModules = new Set(
      (temporalContext?.hotspots ?? []).map((item) => item.module)
    );
    const packagePrimary = primary(
      behavior.byPackage.map((row) => ({
        name: row.package,
        share: share(row.sourceBehaviors, behavior.source),
      }))
    );
    const modulePrimary = primary(
      sourceRows.map((row) => ({
        name: row.module,
        share: share(row.behaviors, behavior.source),
      }))
    );
    const facts: LocalityFacts = {
      anchored: source.anchor?.target === origin.package,
      behavior,
      changeSurface: {
        converterModules: sourceRows.filter(
          (row) => row.conversionBehaviors > 0
        ).length,
        hotspotModules: sourceRows.filter((row) =>
          hotspotModules.has(row.module)
        ).length,
        implementationModules: sourceRows.filter(
          (row) => row.implementationBehaviors > 0
        ).length,
        packages: sourcePackages.length,
        sourceModules: sourceModules.length,
        stronglyCoupledBehaviorModules: coupled.size,
      },
      concentration: {
        ...(packagePrimary.name !== undefined && {
          primaryPackage: packagePrimary.name,
        }),
        primaryPackageShare: packagePrimary.share,
        ...(modulePrimary.name !== undefined && {
          primaryModule: modulePrimary.name,
        }),
        primaryModuleShare: modulePrimary.share,
      },
      concept: ownership.concept,
      distribution: {
        representation: {
          ...(analysis.representations.primaryPackage !== undefined && {
            package: analysis.representations.primaryPackage,
          }),
          share: analysis.representations.primaryShare,
        },
        usage: {
          ...(analysis.references.primaryPackage !== undefined && {
            package: analysis.references.primaryPackage,
          }),
          share: analysis.references.primaryShare,
        },
      },
      halo: {
        modules: analysis.references.byModule.length,
        packages: analysis.references.packageCount,
        references: analysis.references.total,
      },
      span: {
        boundaryEdges,
        moduleCount: behavior.byModule.length,
        packageBoundaryCount: boundaryEdges.length,
        packageCount: behavior.byPackage.length,
        sourceModuleCount: sourceModules.length,
        sourcePackageCount: sourcePackages.length,
      },
      traversal,
      ...(temporalContext !== undefined && { temporal: temporalContext }),
      contractWithoutImplementations: ownership.cautions.some(
        (caution) => caution.kind === "no-implementation-evidence"
      ),
      foreignSourceBehavior: sourcePackages.some((pkg) => pkg !== targetName),
    };
    return assessLocality(facts, config);
  });

  const count = (shape: BehavioralLocalityShape) =>
    concepts.filter((concept) => concept.shape.primary === shape).length;
  return {
    concepts,
    summary: {
      analyzed: concepts.length,
      behaviorLight: count("behavior-light"),
      crossPackageDistributed: count("cross-package-distributed"),
      crossPackageLocalized: count("cross-package-localized"),
      insufficientEvidence: count("insufficient-evidence"),
      local: count("local"),
      parallelImplementations: concepts.filter((concept) =>
        concept.shape.modifiers.includes("parallel-implementations")
      ).length,
      singlePackageDistributed: count("single-package-distributed"),
    },
    target: targetName,
  };
}
