import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import {
  buildAdjacency,
  type Condensation,
  condense,
  longestPathLengths,
} from "./gravity";
import type {
  InternalConsumedSymbol,
  InternalCycle,
  InternalCycleScope,
  InternalDirectoryEdge,
  InternalDirectoryNode,
  InternalDistribution,
  InternalEdgeLocality,
  InternalEdgeSymbol,
  InternalLayer,
  InternalModuleEdge,
  InternalModuleNode,
  InternalModuleRole,
  InternalModuleRoleAssignment,
  InternalPackageTopology,
  InternalRegionNode,
  InternalSeam,
  InternalSeamSymbol,
  InternalSymbolConsumer,
  InternalTopologySummary,
} from "./internal-topology-types";
import { INTERNAL_PACKAGE_TOPOLOGY_SCHEMA_VERSION } from "./internal-topology-types";
import type {
  PackageLocalImport,
  PackageLocalReport,
} from "./package-local-types";
import type { FileKind } from "./types";

// V13.0 internal package topology. A pure function of one
// `PackageLocalReport`: no file system, no TypeScript program, no workspace.
// Module ids are package-relative so the same package yields the same
// topology wherever it sits. Every metric is a graph fact; nothing here
// interprets a shape as good or bad.
//
// Primary topology is the subgraph of `source`-kind modules. Test, story,
// and config modules stay as nodes and their edges stay in `edges`, but
// fan counts, cycles, layers, seams, and roles are measured on primary
// edges only, so a large test suite never becomes the package's shape.

const ROOT_DIRECTORY = ".";
const FILE_KINDS: FileKind[] = ["source", "test", "story", "config", "other"];

type SiteKey = string;

interface EdgeAccumulator {
  bindingOccurrences: number;
  importSites: number;
  namespaceSites: number;
  reExportSites: number;
  sideEffectSites: number;
  source: string;
  symbols: Map<string, InternalEdgeSymbol>;
  target: string;
  typeOnlySites: number;
  valueSites: number;
}

interface Resolution {
  declarationModule: string;
  symbolId: string;
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id.localeCompare(b.id);
}

/** Nearest-rank percentile; 0 for an empty list. */
function nearestRank(sorted: number[], percentile: number): number {
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)] ?? 0;
}

export function distribution(values: number[]): InternalDistribution {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    max: sorted.at(-1) ?? 0,
    median: nearestRank(sorted, 0.5),
    min: sorted[0] ?? 0,
    p90: nearestRank(sorted, 0.9),
  };
}

function share(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

function directoryOf(module: string): string {
  const slash = module.lastIndexOf("/");
  return slash === -1 ? ROOT_DIRECTORY : module.slice(0, slash);
}

function segments(directory: string): string[] {
  return directory === ROOT_DIRECTORY ? [] : directory.split("/");
}

function parentOf(directory: string): string | undefined {
  const parts = segments(directory);
  if (parts.length === 0) {
    return undefined;
  }
  return parts.length === 1 ? ROOT_DIRECTORY : parts.slice(0, -1).join("/");
}

/** Every ancestor including the directory itself, root first. */
function lineage(directory: string): string[] {
  const parts = segments(directory);
  const result = [ROOT_DIRECTORY];
  for (let depth = 1; depth <= parts.length; depth += 1) {
    result.push(parts.slice(0, depth).join("/"));
  }
  return result;
}

/**
 * First directory segment after stripping one leading technical root; the
 * package root (`"."`) when nothing remains. `src/canvas/a.ts` → `canvas`,
 * `src/a.ts` → `.`, `test/a.test.ts` → `test`.
 */
function regionOfDirectory(
  directory: string,
  technicalRoots: string[]
): string {
  const parts = segments(directory);
  const start = technicalRoots.includes(parts[0] ?? "") ? 1 : 0;
  return parts[start] ?? ROOT_DIRECTORY;
}

function directoryDistance(a: string, b: string): number {
  const left = segments(a);
  const right = segments(b);
  let common = 0;
  while (
    common < left.length &&
    common < right.length &&
    left[common] === right[common]
  ) {
    common += 1;
  }
  return left.length + right.length - 2 * common;
}

/** Articulation points of an undirected graph: iterative Tarjan lowpoint DFS. */
function articulationPoints(
  nodes: string[],
  neighbors: Map<string, Set<string>>
): Set<string> {
  const discovered = new Map<string, number>();
  const low = new Map<string, number>();
  const points = new Set<string>();
  let time = 0;
  for (const root of nodes) {
    if (discovered.has(root)) {
      continue;
    }
    let rootChildren = 0;
    const stack: { node: string; parent?: string; queue: string[] }[] = [];
    discovered.set(root, time);
    low.set(root, time);
    time += 1;
    stack.push({ node: root, queue: [...(neighbors.get(root) ?? [])] });
    ({ time, rootChildren } = articulationPointsEntries(
      stack,
      discovered,
      low,
      time,
      root,
      rootChildren,
      neighbors,
      points
    ));
    if (rootChildren > 1) {
      points.add(root);
    }
  }
  return points;
}

function articulationPointsEntries(
  stack: { node: string; parent?: string; queue: string[] }[],
  discovered: Map<string, number>,
  low: Map<string, number>,
  initialTime: number,
  root: string,
  initialRootChildren: number,
  neighbors: Map<string, Set<string>>,
  points: Set<string>
): { time: number; rootChildren: number } {
  let rootChildren = initialRootChildren;
  let time = initialTime;
  while (stack.length > 0) {
    const frame = stack.at(-1);
    if (frame === undefined) {
      break;
    }
    const next = frame.queue.shift();
    if (next !== undefined) {
      if (next === frame.parent) {
        continue;
      }
      if (discovered.has(next)) {
        low.set(
          frame.node,
          Math.min(low.get(frame.node) ?? 0, discovered.get(next) ?? 0)
        );
        continue;
      }
      discovered.set(next, time);
      low.set(next, time);
      time += 1;
      rootChildren += Number(frame.node === root);
      stack.push({
        node: next,
        parent: frame.node,
        queue: [...(neighbors.get(next) ?? [])],
      });
      continue;
    }
    stack.pop();
    const { parent } = frame;
    if (parent === undefined) {
      continue;
    }
    low.set(parent, Math.min(low.get(parent) ?? 0, low.get(frame.node) ?? 0));
    articulationPointsEntriesEntries(
      parent,
      root,
      low,
      frame,
      discovered,
      points
    );
  }
  return { rootChildren, time };
}

function articulationPointsEntriesEntries(
  parent: string,
  root: string,
  low: Map<string, number>,
  frame: { node: string; parent?: string; queue: string[] },
  discovered: Map<string, number>,
  points: Set<string>
) {
  if (
    parent !== root &&
    (low.get(frame.node) ?? 0) >= (discovered.get(parent) ?? 0)
  ) {
    points.add(parent);
  }
}

function weakComponentCount(
  nodes: string[],
  neighbors: Map<string, Set<string>>
): number {
  const seen = new Set<string>();
  let count = 0;
  for (const start of nodes) {
    if (seen.has(start)) {
      continue;
    }
    count += 1;
    const queue = [start];
    seen.add(start);
    for (const current of queue) {
      for (const next of neighbors.get(current) ?? []) {
        if (seen.has(next)) {
          continue;
        }
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return count;
}

/**
 * Resolves a name imported from `module` to the declaration it forwards to,
 * following named re-exports, `export *`, and import-then-export
 * forwarding, all from report facts. Cycles of `export *` terminate on the
 * visited set.
 */
class SymbolResolver {
  private readonly declared = new Map<string, Map<string, Resolution>>();
  private readonly namedReExports = new Map<
    string,
    Map<string, { target: string; name: string }>
  >();
  private readonly starReExports = new Map<string, string[]>();
  private readonly memo = new Map<string, Resolution | null>();

  constructor(
    report: Pick<PackageLocalReport, "symbols" | "imports" | "defaultExports">,
    relative: (rootRelative: string) => string
  ) {
    const resolutionsById = new Map<string, Resolution>();
    for (const symbol of report.symbols) {
      const module = relative(symbol.declarationFile);
      const names = this.declared.get(module) ?? new Map<string, Resolution>();
      const resolution = { declarationModule: module, symbolId: symbol.id };
      if (!names.has(symbol.name)) {
        names.set(symbol.name, resolution);
      }
      if (!resolutionsById.has(symbol.id)) {
        resolutionsById.set(symbol.id, resolution);
      }
      this.declared.set(module, names);
    }
    // A module's `default` binds to a named declaration the local report
    // already resolved, possibly in another module; anonymous defaults stay
    // unresolved rather than being named after the file.
    for (const entry of report.defaultExports) {
      if (entry.symbolId === undefined) {
        continue;
      }
      const resolution = resolutionsById.get(entry.symbolId);
      if (resolution === undefined) {
        continue;
      }
      const module = relative(entry.module);
      const names = this.declared.get(module) ?? new Map<string, Resolution>();
      if (!names.has("default")) {
        names.set("default", resolution);
      }
      this.declared.set(module, names);
    }
    this.registerImports(report, relative);
  }

  private registerImports(
    report: Pick<PackageLocalReport, "imports">,
    relative: (rootRelative: string) => string
  ): void {
    for (const site of report.imports) {
      if (site.scope !== "internal" || site.targetModule === undefined) {
        continue;
      }
      const module = relative(site.sourceModule);
      const target = relative(site.targetModule);
      if (site.kind === "star-re-export") {
        const targets = this.starReExports.get(module) ?? [];
        targets.push(target);
        this.starReExports.set(module, targets);
      } else if (
        (site.kind === "re-export" ||
          site.kind === "named" ||
          site.kind === "type") &&
        site.localName !== undefined &&
        site.importedName !== undefined
      ) {
        const forwards =
          this.namedReExports.get(module) ??
          new Map<string, { target: string; name: string }>();
        if (!forwards.has(site.localName)) {
          forwards.set(site.localName, { name: site.importedName, target });
        }
        this.namedReExports.set(module, forwards);
      }
    }
  }

  resolve(module: string, name: string): Resolution | undefined {
    return this.walk(module, name, new Set()) ?? undefined;
  }

  private walk(
    module: string,
    name: string,
    visited: Set<string>
  ): Resolution | null {
    const key = `${module} ${name}`;
    const cached = this.memo.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (visited.has(key)) {
      return null;
    }
    visited.add(key);
    let found: Resolution | null = this.declared.get(module)?.get(name) ?? null;
    if (found === null) {
      const forward = this.namedReExports.get(module)?.get(name);
      if (forward !== undefined) {
        found = this.walk(forward.target, forward.name, visited);
      }
    }
    if (found === null) {
      for (const target of this.starReExports.get(module) ?? []) {
        found = this.walk(target, name, visited);
        if (found !== null) {
          break;
        }
      }
    }
    this.memo.set(key, found);
    return found;
  }
}

export function analyzeInternalPackageTopology(
  report: PackageLocalReport,
  config: AnalysisConfig = ANALYSIS_CONFIG
): InternalPackageTopology {
  const policy = config.internalTopology;
  const prefix = report.package.path === "" ? "" : `${report.package.path}/`;
  const relative = (rootRelative: string) =>
    rootRelative.startsWith(prefix)
      ? rootRelative.slice(prefix.length)
      : rootRelative;

  const kindOf = new Map<string, FileKind>();
  for (const file of report.sources) {
    kindOf.set(relative(file.path), file.kind);
  }
  const moduleIds = [...kindOf.keys()].sort((a, b) => a.localeCompare(b));
  const isPrimary = (module: string) => kindOf.get(module) === "source";
  const regionOfModule = (module: string) =>
    regionOfDirectory(directoryOf(module), policy.technicalRoots);

  const declaredCount = new Map<string, number>();
  const exportedCount = new Map<string, number>();
  analyzeInternalPackageTopologySymbol(
    report,
    relative,
    declaredCount,
    exportedCount
  );

  const resolver = new SymbolResolver(report, relative);

  const accumulators = new Map<SiteKey, EdgeAccumulator>();
  const selfImports = new Set<string>();
  const externalSpecifiers = new Map<string, Set<string>>();
  analyzeInternalPackageTopologySite(
    report,
    relative,
    kindOf,
    externalSpecifiers,
    selfImports,
    accumulators,
    resolver
  );

  const edges: InternalModuleEdge[] = [...accumulators.values()]
    .map((edge) => {
      const sourceDirectory = directoryOf(edge.source);
      const targetDirectory = directoryOf(edge.target);
      let locality: InternalEdgeLocality;
      if (sourceDirectory === targetDirectory) {
        locality = "same-directory";
      } else if (regionOfModule(edge.source) === regionOfModule(edge.target)) {
        locality = "same-region";
      } else {
        locality = "cross-region";
      }
      return {
        bindingOccurrences: edge.bindingOccurrences,
        distance: directoryDistance(sourceDirectory, targetDirectory),
        importSites: edge.importSites,
        locality,
        namespaceSites: edge.namespaceSites,
        primary: isPrimary(edge.source) && isPrimary(edge.target),
        reExportSites: edge.reExportSites,
        sideEffectSites: edge.sideEffectSites,
        source: edge.source,
        symbols: [...edge.symbols.values()].sort((a, b) =>
          a.name.localeCompare(b.name)
        ),
        target: edge.target,
        typeOnlySites: edge.typeOnlySites,
        valueSites: edge.valueSites,
      };
    })
    .sort(
      (a, b) =>
        a.source.localeCompare(b.source) || a.target.localeCompare(b.target)
    );
  const primaryEdges = edges.filter((edge) => edge.primary);
  const primaryModules = moduleIds.filter(isPrimary);

  const graph = buildAdjacency(
    primaryModules,
    primaryEdges.map((edge) => [edge.source, edge.target])
  );
  const condensation = condense(graph);
  const layerOf = longestPathLengths(condensation.out);
  const undirected = new Map<string, Set<string>>();
  for (const module of primaryModules) {
    undirected.set(module, new Set());
  }
  for (const edge of primaryEdges) {
    undirected.get(edge.source)?.add(edge.target);
    undirected.get(edge.target)?.add(edge.source);
  }
  const articulation = articulationPoints(primaryModules, undirected);

  const incomingSites = new Map<string, number>();
  const outgoingSites = new Map<string, number>();
  const consumedNames = new Map<string, Set<string>>();
  const contextConsumers = new Map<string, Set<string>>();
  const visitEdge3 = () => {
    for (const edge of edges) {
      if (edge.primary) {
        incomingSites.set(
          edge.target,
          (incomingSites.get(edge.target) ?? 0) + edge.importSites
        );
        outgoingSites.set(
          edge.source,
          (outgoingSites.get(edge.source) ?? 0) + edge.importSites
        );
        const names = consumedNames.get(edge.source) ?? new Set<string>();
        for (const symbol of edge.symbols) {
          names.add(symbol.name);
        }
        consumedNames.set(edge.source, names);
      } else if (isPrimary(edge.target) && !isPrimary(edge.source)) {
        const consumers =
          contextConsumers.get(edge.target) ?? new Set<string>();
        consumers.add(edge.source);
        contextConsumers.set(edge.target, consumers);
      }
    }
  };
  visitEdge3();

  // Internal consumed surface: every resolved symbol on a primary edge,
  // attributed to its declaring module rather than the module imported from.
  const visitEdge4 = () => {
    for (const edge of primaryEdges) {
      for (const symbol of edge.symbols) {
        if (
          symbol.symbolId === undefined ||
          symbol.declarationModule === undefined ||
          symbol.declarationModule === edge.source ||
          symbol.reExportSites === symbol.importSites + symbol.namespaceSites
        ) {
          continue;
        }
        const entry = consumed.get(symbol.symbolId) ?? {
          consumers: new Map<string, InternalSymbolConsumer>(),
          module: symbol.declarationModule,
          name: symbolById.get(symbol.symbolId)?.name ?? symbol.name,
          symbolId: symbol.symbolId,
        };
        consumed.set(symbol.symbolId, entry);
        const consumer = entry.consumers.get(edge.source) ?? {
          bindingOccurrences: 0,
          importSites: 0,
          module: edge.source,
          namespaceSites: 0,
          typeOnlySites: 0,
          ...(symbol.mediated && { via: edge.target }),
        };
        consumer.importSites += symbol.importSites;
        consumer.typeOnlySites += symbol.typeOnlySites;
        consumer.namespaceSites += symbol.namespaceSites;
        consumer.bindingOccurrences += symbol.bindingOccurrences;
        entry.consumers.set(edge.source, consumer);
      }
    }
  };
  // A site that only forwards the symbol (`export … from`) is not a consumer.
  const consumed = new Map<
    string,
    {
      symbolId: string;
      name: string;
      module: string;
      consumers: Map<string, InternalSymbolConsumer>;
    }
  >();
  const symbolById = new Map(
    report.symbols.map((symbol) => [symbol.id, symbol])
  );
  visitEdge4();
  const consumedSurface: InternalConsumedSymbol[] = [...consumed.values()]
    .map((entry) => {
      const consumers = [...entry.consumers.values()].sort((a, b) =>
        a.module.localeCompare(b.module)
      );
      return {
        bindingOccurrences: consumers.reduce(
          (sum, c) => sum + c.bindingOccurrences,
          0
        ),
        consumerDirectories: [
          ...new Set(consumers.map((consumer) => directoryOf(consumer.module))),
        ].sort((a, b) => a.localeCompare(b)),
        consumerModules: consumers.length,
        consumerRegions: [
          ...new Set(
            consumers.map((consumer) => regionOfModule(consumer.module))
          ),
        ].sort((a, b) => a.localeCompare(b)),
        consumers,
        declarationModule: entry.module,
        declarationRegion: regionOfModule(entry.module),
        exported: symbolById.get(entry.symbolId)?.exported ?? false,
        importSites: consumers.reduce((sum, c) => sum + c.importSites, 0),
        name: entry.name,
        namespaceSites: consumers.reduce((sum, c) => sum + c.namespaceSites, 0),
        symbolId: entry.symbolId,
      };
    })
    .sort(
      (a, b) =>
        b.consumerModules - a.consumerModules ||
        a.symbolId.localeCompare(b.symbolId)
    );
  const providedByModule = new Map<string, Set<string>>();
  const consumersByModule = new Map<string, Set<string>>();
  analyzeInternalPackageTopologySymbol2(
    consumedSurface,
    providedByModule,
    consumersByModule
  );

  const cycleIds = new Map<string, string>();
  const componentMembers = new Map<string, string[]>();
  analyzeInternalPackageTopologyModule(
    primaryModules,
    condensation,
    componentMembers
  );
  const cyclicComponents = [...componentMembers.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([component, members]) => ({ component, members: members.sort() }))
    .sort(
      (a, b) =>
        b.members.length - a.members.length ||
        (a.members[0] ?? "").localeCompare(b.members[0] ?? "")
    );
  cyclicComponents.forEach(({ component, members }, index) => {
    const id = `cycle-${index + 1}`;
    cycleIds.set(component, id);
    for (const member of members) {
      cycleIds.set(member, id);
    }
  });

  const modules: InternalModuleNode[] = moduleIds.map((id) => {
    const primary = isPrimary(id);
    const component = condensation.componentOf.get(id);
    const cycle = cycleIds.get(id);
    return {
      consumedSymbols: consumedNames.get(id)?.size ?? 0,
      contextFanIn: contextConsumers.get(id)?.size ?? 0,
      declaredSymbols: declaredCount.get(id) ?? 0,
      directory: directoryOf(id),
      exportedSymbols: exportedCount.get(id) ?? 0,
      externalFanOut: externalSpecifiers.get(id)?.size ?? 0,
      fanIn: graph.into.get(id)?.size ?? 0,
      fanOut: graph.out.get(id)?.size ?? 0,
      fileKind: kindOf.get(id) ?? "other",
      id,
      incomingImportSites: incomingSites.get(id) ?? 0,
      outgoingImportSites: outgoingSites.get(id) ?? 0,
      primary,
      providedSymbols: providedByModule.get(id)?.size ?? 0,
      region: regionOfModule(id),
      symbolConsumers: consumersByModule.get(id)?.size ?? 0,
      syntacticRole: report.moduleRoles[`${prefix}${id}`] ?? {
        entrypoint: false,
        kind: "internal",
        ownDeclarations: 0,
        reExports: 0,
      },
      ...(primary &&
        component !== undefined && { layer: layerOf.get(component) ?? 0 }),
      ...(cycle !== undefined && { cycle }),
    };
  });
  const moduleById = new Map(modules.map((module) => [module.id, module]));

  // Directory tree from module paths; every ancestor of an owning directory
  // is a node, so the hierarchy is complete even where a level holds no file.
  const directoryModules = new Map<string, string[]>();
  const descendants = new Map<string, number>([[ROOT_DIRECTORY, 0]]);
  analyzeInternalPackageTopologyId2(moduleIds, directoryModules, descendants);
  const visitEdge = () => {
    for (const edge of primaryEdges) {
      const fromLineage = lineage(directoryOf(edge.source));
      const toLineage = new Set(lineage(directoryOf(edge.target)));
      for (const directory of fromLineage) {
        const stats = directoryStats.get(directory);
        if (stats === undefined) {
          continue;
        }
        if (toLineage.has(directory)) {
          stats.internal += 1;
          toLineage.delete(directory);
        } else {
          stats.outgoing += 1;
        }
      }
      for (const directory of toLineage) {
        const stats = directoryStats.get(directory);
        if (stats !== undefined) {
          stats.incoming += 1;
        }
      }
    }
  };
  const directoryIds = [...descendants.keys()].sort((a, b) =>
    a.localeCompare(b)
  );
  const children = new Map<string, string[]>();
  analyzeInternalPackageTopologyId3(directoryIds, children);
  const visitEdge5 = () => {
    for (const edge of primaryEdges) {
      const from = directoryOf(edge.source);
      const to = directoryOf(edge.target);
      if (from === to) {
        continue;
      }
      const key = `${from} ${to}`;
      const entry = directoryEdgeMap.get(key) ?? {
        from,
        importSites: 0,
        moduleEdges: 0,
        sources: new Set<string>(),
        symbols: new Set<string>(),
        targets: new Set<string>(),
        to,
      };
      directoryEdgeMap.set(key, entry);
      entry.moduleEdges += 1;
      entry.importSites += edge.importSites;
      for (const symbol of edge.symbols) {
        entry.symbols.add(symbol.name);
      }
      entry.sources.add(edge.source);
      entry.targets.add(edge.target);
    }
  };
  const directoryStats = new Map<
    string,
    { internal: number; incoming: number; outgoing: number }
  >();
  for (const directory of directoryIds) {
    directoryStats.set(directory, { incoming: 0, internal: 0, outgoing: 0 });
  }
  // An edge is internal to every shared ancestor, outgoing from the
  // source-only ancestors, incoming to the target-only ones.
  visitEdge();
  const directories: InternalDirectoryNode[] = directoryIds.map((id) => {
    const parent = parentOf(id);
    const stats = directoryStats.get(id) ?? {
      incoming: 0,
      internal: 0,
      outgoing: 0,
    };
    return {
      id,
      ...(parent !== undefined && { parent }),
      childDirectories: children.get(id) ?? [],
      depth: segments(id).length,
      descendantModules: descendants.get(id) ?? 0,
      directModules: [...(directoryModules.get(id) ?? [])].sort(),
      incomingEdges: stats.incoming,
      internalEdges: stats.internal,
      outgoingEdges: stats.outgoing,
      region: regionOfDirectory(id, policy.technicalRoots),
    };
  });

  const directoryEdgeMap = new Map<
    string,
    {
      from: string;
      to: string;
      moduleEdges: number;
      importSites: number;
      symbols: Set<string>;
      sources: Set<string>;
      targets: Set<string>;
    }
  >();
  visitEdge5();
  const directoryEdges: InternalDirectoryEdge[] = [...directoryEdgeMap.values()]
    .map((entry) => ({
      from: entry.from,
      importSites: entry.importSites,
      moduleEdges: entry.moduleEdges,
      sourceModules: entry.sources.size,
      symbols: entry.symbols.size,
      targetModules: entry.targets.size,
      to: entry.to,
    }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const visitEdge2 = () => {
    for (const edge of primaryEdges) {
      const from = regionOfModule(edge.source);
      const to = regionOfModule(edge.target);
      if (from === to) {
        const stats = regionStats.get(from);
        if (stats !== undefined) {
          stats.internal += 1;
        }
        continue;
      }
      const fromStats = regionStats.get(from);
      const toStats = regionStats.get(to);
      if (fromStats !== undefined) {
        fromStats.outgoing += 1;
        fromStats.outbound.add(edge.source);
      }
      if (toStats !== undefined) {
        toStats.incoming += 1;
        toStats.inbound.add(edge.target);
      }
      const key = `${from} ${to}`;
      const seam = seamMap.get(key) ?? { edges: [], from, to };
      seam.edges.push(edge);
      seamMap.set(key, seam);
    }
  };

  const regionModules = new Map<string, string[]>();
  for (const id of moduleIds) {
    const region = regionOfModule(id);
    const list = regionModules.get(region) ?? [];
    list.push(id);
    regionModules.set(region, list);
  }
  const regionPrimaryCount = new Map<string, number>();
  for (const [region, list] of regionModules) {
    regionPrimaryCount.set(region, list.filter(isPrimary).length);
  }
  const seamMap = new Map<
    string,
    {
      from: string;
      to: string;
      edges: InternalModuleEdge[];
    }
  >();
  const regionStats = new Map<
    string,
    {
      internal: number;
      incoming: number;
      outgoing: number;
      outbound: Set<string>;
      inbound: Set<string>;
    }
  >();
  for (const region of regionModules.keys()) {
    regionStats.set(region, {
      inbound: new Set(),
      incoming: 0,
      internal: 0,
      outbound: new Set(),
      outgoing: 0,
    });
  }
  visitEdge2();
  const regions: InternalRegionNode[] = [...regionModules.entries()]
    .map(([id, list]) => {
      const stats = regionStats.get(id);
      return {
        directories: new Set(list.map(directoryOf)).size,
        id,
        inboundModules: stats?.inbound.size ?? 0,
        incomingEdges: stats?.incoming ?? 0,
        internalEdges: stats?.internal ?? 0,
        modules: list.length,
        outboundModules: stats?.outbound.size ?? 0,
        outgoingEdges: stats?.outgoing ?? 0,
        primaryModules: regionPrimaryCount.get(id) ?? 0,
      };
    })
    .sort(byId);

  const topParticipant = (
    counts: Map<string, number>,
    total: number
  ): { module: string; moduleEdges: number; share: number } => {
    const [module, moduleEdges] = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    )[0] ?? ["", 0];
    return { module, moduleEdges, share: share(moduleEdges, total) };
  };
  const symbolCounts = (list: InternalModuleEdge[]) => {
    const counts = new Map<string, number>();
    for (const edge of list) {
      for (const symbol of edge.symbols) {
        counts.set(
          symbol.name,
          (counts.get(symbol.name) ?? 0) + symbol.importSites
        );
      }
    }
    return counts;
  };
  const rankedSymbols = (
    counts: Map<string, number>,
    limit: number
  ): InternalSeamSymbol[] => {
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([name, importSites]) => ({
        importSites,
        name,
        share: share(importSites, total),
      }));
  };
  const seams: InternalSeam[] = [...seamMap.values()]
    .map(({ from, to, edges: list }) => {
      const sources = new Map<string, number>();
      const targets = new Map<string, number>();
      let importSites = 0;
      let bindingOccurrences = 0;
      let aggregatorTargets = 0;
      for (const edge of list) {
        sources.set(edge.source, (sources.get(edge.source) ?? 0) + 1);
        targets.set(edge.target, (targets.get(edge.target) ?? 0) + 1);
        importSites += edge.importSites;
        bindingOccurrences += edge.bindingOccurrences;
        if (moduleById.get(edge.target)?.syntacticRole.kind === "aggregator") {
          aggregatorTargets += 1;
        }
      }
      const symbols = symbolCounts(list);
      const [topSymbol] = rankedSymbols(symbols, 1);
      return {
        bindingOccurrences,
        from,
        importSites,
        moduleEdges: list.length,
        sourceModules: [...sources.keys()].sort(),
        sourceParticipation: share(
          sources.size,
          regionPrimaryCount.get(from) ?? 0
        ),
        symbolFlow: symbols.size,
        targetModules: [...targets.keys()].sort(),
        targetParticipation: share(
          targets.size,
          regionPrimaryCount.get(to) ?? 0
        ),
        to,
        topSource: topParticipant(sources, list.length),
        topTarget: topParticipant(targets, list.length),
        ...(topSymbol !== undefined && { topSymbol }),
        aggregatorTargetShare: share(aggregatorTargets, list.length),
      };
    })
    .sort(
      (a, b) =>
        b.moduleEdges - a.moduleEdges ||
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to)
    );

  const cycles: InternalCycle[] = cyclicComponents.map(
    ({ component, members }) => {
      const memberSet = new Set(members);
      const internal = primaryEdges.filter(
        (edge) => memberSet.has(edge.source) && memberSet.has(edge.target)
      );
      const entry = primaryEdges.filter(
        (edge) => !memberSet.has(edge.source) && memberSet.has(edge.target)
      ).length;
      const exit = primaryEdges.filter(
        (edge) => memberSet.has(edge.source) && !memberSet.has(edge.target)
      ).length;
      const cycleDirectories = [...new Set(members.map(directoryOf))].sort();
      const cycleRegions = [...new Set(members.map(regionOfModule))].sort();
      let scope: InternalCycleScope;
      if (cycleDirectories.length === 1) {
        scope = "directory";
      } else if (cycleRegions.length === 1) {
        scope = "region";
      } else {
        scope = "cross-region";
      }
      const symbols = symbolCounts(internal);
      return {
        directories: cycleDirectories,
        entryEdges: entry,
        exitEdges: exit,
        id: cycleIds.get(component) ?? component,
        importSites: internal.reduce((sum, edge) => sum + edge.importSites, 0),
        internalEdges: internal.length,
        modules: members,
        regions: cycleRegions,
        scope,
        symbolFlow: symbols.size,
        topSymbols: rankedSymbols(symbols, policy.report.topSymbols),
      };
    }
  );

  const layerMap = new Map<number, string[]>();
  analyzeInternalPackageTopologyModule2(modules, layerMap);
  const layers: InternalLayer[] = [...layerMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, list]) => ({ index, modules: list.sort() }));

  const fanIns = primaryModules.map((id) => moduleById.get(id)?.fanIn ?? 0);
  const fanOuts = primaryModules.map((id) => moduleById.get(id)?.fanOut ?? 0);
  // Cutoff over the connected modules only, so a package where most modules
  // have no dependents still ranks the ones that do.
  const cutoff = (values: number[]) => {
    const connected = values.filter((value) => value > 0).sort((a, b) => a - b);
    if (connected.length === 0) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.max(
      policy.highFan.minimum,
      nearestRank(connected, policy.highFan.percentile)
    );
  };
  const highFanCutoff = { fanIn: cutoff(fanIns), fanOut: cutoff(fanOuts) };

  const roles: InternalModuleRoleAssignment[] = [];
  analyzeInternalPackageTopologyId(
    primaryModules,
    moduleById,
    highFanCutoff,
    articulation,
    undirected,
    roles
  );
  const roleCount = (role: InternalModuleRole) =>
    roles.filter((assignment) => assignment.roles.includes(role)).length;

  const modulesByKind = Object.fromEntries(
    FILE_KINDS.map((kind) => [kind, 0])
  ) as Record<FileKind, number>;
  for (const module of modules) {
    modulesByKind[module.fileKind] += 1;
  }
  const contextEdgesByKind = Object.fromEntries(
    FILE_KINDS.map((kind) => [kind, 0])
  ) as Record<FileKind, number>;
  for (const edge of edges) {
    if (edge.primary) {
      continue;
    }
    contextEdgesByKind[kindOf.get(edge.source) ?? "other"] += 1;
  }

  const summary: InternalTopologySummary = {
    aggregators: roleCount("aggregator"),
    bridges: roleCount("bridge"),
    contextEdgesByKind,
    crossRegionCycles: cycles.filter((cycle) => cycle.scope === "cross-region")
      .length,
    cycleMembers: cycles.reduce((sum, cycle) => sum + cycle.modules.length, 0),
    cycles: cycles.length,
    dependencySinks: roleCount("dependency-sink"),
    dependencySources: roleCount("dependency-source"),
    directories: directories.length,
    distributions: {
      directoryModules: distribution(
        directories.map((directory) => directory.directModules.length)
      ),
      edgeSymbols: distribution(
        primaryEdges.map((edge) => edge.symbols.length)
      ),
      fanIn: distribution(fanIns),
      fanOut: distribution(fanOuts),
      seamModuleEdges: distribution(seams.map((seam) => seam.moduleEdges)),
    },
    edges: edges.length,
    highFanCutoff: {
      fanIn: Number.isFinite(highFanCutoff.fanIn) ? highFanCutoff.fanIn : 0,
      fanOut: Number.isFinite(highFanCutoff.fanOut) ? highFanCutoff.fanOut : 0,
    },
    highFanIn: roleCount("high-fan-in"),
    highFanOut: roleCount("high-fan-out"),
    isolated: roleCount("isolated"),
    largestCycle: cycles[0]?.modules.length ?? 0,
    layers: layers.length,
    modules: modules.length,
    modulesByKind,
    primaryEdges: primaryEdges.length,
    primaryModules: primaryModules.length,
    regions: regions.length,
    satellites: roleCount("satellite"),
    seams: seams.length,
    selfImports: selfImports.size,
    weakComponents: weakComponentCount(primaryModules, undirected),
  };

  return {
    consumedSurface,
    cycles,
    directories,
    directoryEdges,
    edges,
    layers,
    modules,
    package: {
      id: report.package.name ?? report.package.path,
      root: report.package.path,
    },
    policy: {
      highFan: { ...policy.highFan },
      layer:
        "longest primary dependency chain to a sink on the SCC condensation",
      primaryEdge: "both endpoints source-kind",
      structuralConnectivity: "undirected-projection",
      technicalRoots: [...policy.technicalRoots],
    },
    regions,
    roles,
    schemaVersion: INTERNAL_PACKAGE_TOPOLOGY_SCHEMA_VERSION,
    seams,
    selfImports: [...selfImports].sort(),
    summary,
  };
}

export interface InternalModuleNeighborhood {
  /** Symbols this module consumes from others, by edge target. */
  consumed: InternalEdgeSymbol[];
  consumers: InternalModuleEdge[];
  dependencies: InternalModuleEdge[];
  directory: InternalDirectoryNode | undefined;
  module: InternalModuleNode;
  /** Own declarations other modules consume. */
  provided: InternalConsumedSymbol[];
}

function analyzeInternalPackageTopologyModule2(
  modules: InternalModuleNode[],
  layerMap: Map<number, string[]>
) {
  for (const module of modules) {
    if (module.layer === undefined) {
      continue;
    }
    const list = layerMap.get(module.layer) ?? [];
    list.push(module.id);
    layerMap.set(module.layer, list);
  }
}

function analyzeInternalPackageTopologyId3(
  directoryIds: string[],
  children: Map<string, string[]>
) {
  for (const id of directoryIds) {
    const parent = parentOf(id);
    if (parent === undefined) {
      continue;
    }
    const list = children.get(parent) ?? [];
    list.push(id);
    children.set(parent, list);
  }
}

function analyzeInternalPackageTopologyId2(
  moduleIds: string[],
  directoryModules: Map<string, string[]>,
  descendants: Map<string, number>
) {
  for (const id of moduleIds) {
    const owning = directoryOf(id);
    const list = directoryModules.get(owning) ?? [];
    list.push(id);
    directoryModules.set(owning, list);
    for (const ancestor of lineage(owning)) {
      descendants.set(ancestor, (descendants.get(ancestor) ?? 0) + 1);
    }
  }
}

function analyzeInternalPackageTopologyModule(
  primaryModules: string[],
  condensation: Condensation,
  componentMembers: Map<string, string[]>
) {
  for (const module of primaryModules) {
    const component = condensation.componentOf.get(module);
    if (component === undefined) {
      continue;
    }
    const members = componentMembers.get(component) ?? [];
    members.push(module);
    componentMembers.set(component, members);
  }
}

function analyzeInternalPackageTopologySymbol2(
  consumedSurface: InternalConsumedSymbol[],
  providedByModule: Map<string, Set<string>>,
  consumersByModule: Map<string, Set<string>>
) {
  for (const symbol of consumedSurface) {
    const provided =
      providedByModule.get(symbol.declarationModule) ?? new Set();
    provided.add(symbol.symbolId);
    providedByModule.set(symbol.declarationModule, provided);
    const consumers =
      consumersByModule.get(symbol.declarationModule) ?? new Set();
    for (const consumer of symbol.consumers) {
      consumers.add(consumer.module);
    }
    consumersByModule.set(symbol.declarationModule, consumers);
  }
}

function analyzeInternalPackageTopologySymbol(
  report: PackageLocalReport,
  relative: (rootRelative: string) => string,
  declaredCount: Map<string, number>,
  exportedCount: Map<string, number>
) {
  for (const symbol of report.symbols) {
    const module = relative(symbol.declarationFile);
    declaredCount.set(module, (declaredCount.get(module) ?? 0) + 1);
    if (symbol.exported) {
      exportedCount.set(module, (exportedCount.get(module) ?? 0) + 1);
    }
  }
}

function analyzeInternalPackageTopologySite(
  report: PackageLocalReport,
  relative: (rootRelative: string) => string,
  kindOf: Map<string, FileKind>,
  externalSpecifiers: Map<string, Set<string>>,
  selfImports: Set<string>,
  accumulators: Map<string, EdgeAccumulator>,
  resolver: SymbolResolver
) {
  const visitSite = (site: PackageLocalImport) =>
    resolveVisitSite(
      relative,
      kindOf,
      externalSpecifiers,
      selfImports,
      accumulators,
      resolver,
      site
    );
  for (const site of report.imports) {
    visitSite(site);
  }
}

function analyzeInternalPackageTopologySiteMember(
  site: PackageLocalImport,
  symbolOn: (name: string) => InternalEdgeSymbol
) {
  for (const member of site.members ?? []) {
    const symbol = symbolOn(member.name);
    symbol.namespaceSites += 1;
    if (site.typeOnly) {
      symbol.typeOnlySites += 1;
    }
    symbol.bindingOccurrences += member.occurrences;
  }
}

function analyzeInternalPackageTopologyId(
  primaryModules: string[],
  moduleById: Map<string, InternalModuleNode>,
  highFanCutoff: { fanIn: number; fanOut: number },
  articulation: Set<string>,
  undirected: Map<string, Set<string>>,
  roles: InternalModuleRoleAssignment[]
) {
  for (const id of primaryModules) {
    const module = moduleById.get(id);
    if (module === undefined) {
      continue;
    }
    const assigned: InternalModuleRole[] = [];
    analyzeInternalPackageTopologyIdEntries(module, assigned);
    if (module.fanIn >= highFanCutoff.fanIn) {
      assigned.push("high-fan-in");
    }
    if (module.fanOut >= highFanCutoff.fanOut) {
      assigned.push("high-fan-out");
    }
    if (module.syntacticRole.kind === "aggregator") {
      assigned.push("aggregator");
    }
    if (articulation.has(id)) {
      assigned.push("bridge");
    }
    if (
      (undirected.get(id)?.size ?? 0) === 1 &&
      module.syntacticRole.kind !== "aggregator"
    ) {
      assigned.push("satellite");
    }
    if (module.cycle !== undefined) {
      assigned.push("cycle-member");
    }
    if (assigned.length > 0) {
      roles.push({ module: id, roles: assigned });
    }
  }
}

function analyzeInternalPackageTopologyIdEntries(
  module: InternalModuleNode,
  assigned: InternalModuleRole[]
) {
  if (module.fanIn === 0 && module.fanOut === 0) {
    assigned.push("isolated");
  } else if (module.fanIn === 0) {
    assigned.push("dependency-source");
  } else if (module.fanOut === 0) {
    assigned.push("dependency-sink");
  }
}

export function getModuleNeighborhood(
  topology: InternalPackageTopology,
  id: string
): InternalModuleNeighborhood | undefined {
  const module = topology.modules.find((candidate) => candidate.id === id);
  if (module === undefined) {
    return undefined;
  }
  const dependencies = topology.edges.filter((edge) => edge.source === id);
  return {
    consumed: dependencies.flatMap((edge) => edge.symbols),
    consumers: topology.edges.filter((edge) => edge.target === id),
    dependencies,
    directory: topology.directories.find(
      (directory) => directory.id === module.directory
    ),
    module,
    provided: topology.consumedSurface.filter(
      (symbol) => symbol.declarationModule === id
    ),
  };
}
function resolveVisitSite(
  relative: (rootRelative: string) => string,
  kindOf: Map<string, FileKind>,
  externalSpecifiers: Map<string, Set<string>>,
  selfImports: Set<string>,
  accumulators: Map<string, EdgeAccumulator>,
  resolver: SymbolResolver,
  site: PackageLocalImport
) {
  const source = relative(site.sourceModule);
  if (!kindOf.has(source)) {
    return;
  }
  if (site.scope === "external" || site.targetModule === undefined) {
    const specifiers = externalSpecifiers.get(source) ?? new Set<string>();
    specifiers.add(site.specifier);
    externalSpecifiers.set(source, specifiers);
    return;
  }
  const target = relative(site.targetModule);
  if (!kindOf.has(target)) {
    return;
  }
  if (source === target) {
    selfImports.add(source);
    return;
  }
  const key = `${source} ${target}`;
  const edge = accumulators.get(key) ?? {
    bindingOccurrences: 0,
    importSites: 0,
    namespaceSites: 0,
    reExportSites: 0,
    sideEffectSites: 0,
    source,
    symbols: new Map<string, InternalEdgeSymbol>(),
    target,
    typeOnlySites: 0,
    valueSites: 0,
  };
  accumulators.set(key, edge);
  edge.importSites += 1;
  if (site.kind === "re-export" || site.kind === "star-re-export") {
    edge.reExportSites += 1;
  }
  if (site.typeOnly) {
    edge.typeOnlySites += 1;
  } else {
    edge.valueSites += 1;
  }
  if (site.kind === "namespace") {
    edge.namespaceSites += 1;
  }
  if (site.kind === "side-effect") {
    edge.sideEffectSites += 1;
  }
  edge.bindingOccurrences += site.bindingOccurrences ?? 0;
  const symbolOn = (name: string) => {
    const symbol = edge.symbols.get(name) ?? {
      name,
      ...resolver.resolve(target, name),
      bindingOccurrences: 0,
      importSites: 0,
      mediated: false,
      namespaceSites: 0,
      reExportSites: 0,
      typeOnlySites: 0,
    };
    symbol.mediated =
      symbol.declarationModule !== undefined &&
      symbol.declarationModule !== target;
    edge.symbols.set(name, symbol);
    return symbol;
  };
  if (site.kind === "namespace") {
    // Only members actually accessed through the binding count; a bare use
    // of the namespace names no symbol and stays a namespace site.
    analyzeInternalPackageTopologySiteMember(site, symbolOn);
    return;
  }
  if (site.importedName === undefined) {
    return;
  }
  const symbol = symbolOn(site.importedName);
  symbol.importSites += 1;
  if (site.kind === "re-export") {
    symbol.reExportSites += 1;
  }
  if (site.typeOnly) {
    symbol.typeOnlySites += 1;
  }
  symbol.bindingOccurrences += site.bindingOccurrences ?? 0;
}
