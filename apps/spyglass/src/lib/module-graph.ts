import { isAbsolute, relative, resolve, sep } from "#path";

import type { Boundary, SourceOwner } from "./boundary-model";
import { boundaryContains, FIXTURE_DIR, toPosix } from "./boundary-model";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type {
  ModuleDependencyEdge,
  PackageConsumer,
  PackageDependency,
  PackageShapeSignal,
  SurfaceDependencies,
  SurfaceSymbol,
  SymbolDependencyUsage,
  UsageNamespace,
  WorkspaceModuleGraph,
} from "./types";

export const EXCLUDE_PATTERNS = [
  "(^|/)(node_modules|dist|build|out|coverage|\\.next|\\.turbo|\\.cache|storybook-static)(/|$)",
  `(^|/)${FIXTURE_DIR}/`,
  "\\.d\\.ts$",

  "(^|/)[^/]+\\.config\\.(ts|tsx|mts|cts|js|mjs|cjs)$",
];

interface IncomingEdges {
  edges: ModuleDependencyEdge[];
  typeOnly: boolean;
}

export interface CrossBoundaryEdges {
  graph: WorkspaceModuleGraph;
  incoming: Map<string, IncomingEdges>;
  outgoing: Map<string, ModuleDependencyEdge[]>;
}

interface CruisedDependency {
  coreModule: boolean;
  couldNotResolve: boolean;
  dependencyTypes: string[];
  resolved: string;
}

export interface CruisedModule {
  dependencies: CruisedDependency[];
  source: string;
}

export interface ModuleGraphLookups {
  ignores(rel: string): boolean;
  ownerOf: SourceOwner;
}

export function normalizeEdges(
  root: string,
  boundary: Boundary,
  modules: CruisedModule[],
  lookups: ModuleGraphLookups
): CrossBoundaryEdges {
  const incoming = new Map<string, IncomingEdges>();
  const outgoing = new Map<string, ModuleDependencyEdge[]>();
  const moduleOwners = new Map<string, string>();

  const graphEdges = new Map<string, ModuleDependencyEdge>();

  const { ownerOf } = lookups;
  const inRoot = (absolute: string) => {
    const rel = relative(root, absolute);
    return (
      rel !== "" &&
      !rel.startsWith("..") &&
      !isAbsolute(rel) &&
      !lookups.ignores(toPosix(rel))
    );
  };

  const registerModule = (absolute: string): string => {
    const rel = toPosix(relative(root, absolute));
    if (!moduleOwners.has(rel)) {
      moduleOwners.set(rel, ownerOf(absolute));
    }
    return rel;
  };

  normalizeEdgesMod(
    modules,
    root,
    ownerOf,
    inRoot,
    registerModule,
    graphEdges,
    boundary,
    incoming,
    outgoing
  );

  const sortEdges = (edges: ModuleDependencyEdge[]) =>
    edges.sort(
      (a, b) =>
        a.fromFile.localeCompare(b.fromFile) || a.toFile.localeCompare(b.toFile)
    );
  for (const entry of incoming.values()) {
    sortEdges(entry.edges);
  }
  for (const edges of outgoing.values()) {
    sortEdges(edges);
  }
  const graph: WorkspaceModuleGraph = {
    edges: sortEdges([...graphEdges.values()]),
    modules: [...moduleOwners.keys()].sort((a, b) => a.localeCompare(b)),
    owners: Object.fromEntries(
      [...moduleOwners.entries()].sort(([a], [b]) => a.localeCompare(b))
    ),
  };
  return { graph, incoming, outgoing };
}

function normalizeEdgesMod(
  modules: CruisedModule[],
  root: string,
  ownerOf: SourceOwner,
  inRoot: (absolute: string) => boolean,
  registerModule: (absolute: string) => string,
  graphEdges: Map<string, ModuleDependencyEdge>,
  boundary: Boundary,
  incoming: Map<string, IncomingEdges>,
  outgoing: Map<string, ModuleDependencyEdge[]>
) {
  for (const mod of modules) {
    const fromAbs = resolve(root, mod.source);
    if (!inRoot(fromAbs) || fromAbs.includes(`${sep}node_modules${sep}`)) {
      continue;
    }
    const fromFile = registerModule(fromAbs);
    normalizeEdgesModDep(
      mod,
      root,
      ownerOf,
      inRoot,
      registerModule,
      fromFile,
      graphEdges,
      boundary,
      fromAbs,
      incoming,
      outgoing
    );
  }
}

function normalizeEdgesModDep(
  mod: CruisedModule,
  root: string,
  ownerOf: SourceOwner,
  inRoot: (absolute: string) => boolean,
  registerModule: (absolute: string) => string,
  fromFile: string,
  graphEdges: Map<string, ModuleDependencyEdge>,
  boundary: Boundary,
  fromAbs: string,
  incoming: Map<string, IncomingEdges>,
  outgoing: Map<string, ModuleDependencyEdge[]>
) {
  for (const dep of mod.dependencies) {
    if (dep.coreModule || dep.couldNotResolve) {
      continue;
    }
    const toAbs = resolve(root, dep.resolved);
    if (!inRoot(toAbs) || toAbs.includes(`${sep}node_modules${sep}`)) {
      continue;
    }
    const toFile = registerModule(toAbs);
    if (fromFile === toFile) {
      continue;
    }
    const pairKey = `${fromFile}\0${toFile}`;
    const typeOnly = dep.dependencyTypes.includes("type-only");
    const known = graphEdges.get(pairKey);
    const firstSighting = known === undefined;
    const edge: ModuleDependencyEdge = known ?? {
      fromFile,
      toFile,
      typeOnly,
    };
    if (known === undefined) {
      graphEdges.set(pairKey, edge);
    } else if (!typeOnly) {
      edge.typeOnly = false;
    }
    const fromIn = boundaryContains(boundary, fromAbs);
    const toIn = boundaryContains(boundary, toAbs);
    if (fromIn === toIn) {
      continue;
    }

    normalizeEdgesModDepEntries(
      toIn,
      ownerOf,
      fromAbs,
      incoming,
      firstSighting,
      edge,
      typeOnly,
      toAbs,
      outgoing
    );
  }
}

function normalizeEdgesModDepEntries(
  toIn: boolean,
  ownerOf: SourceOwner,
  fromAbs: string,
  incoming: Map<string, IncomingEdges>,
  firstSighting: boolean,
  edge: ModuleDependencyEdge,
  typeOnly: boolean,
  toAbs: string,
  outgoing: Map<string, ModuleDependencyEdge[]>
) {
  if (toIn) {
    const owner = ownerOf(fromAbs);
    const entry = incoming.get(owner) ?? { edges: [], typeOnly: true };
    incoming.set(owner, entry);
    if (firstSighting) {
      entry.edges.push(edge);
    }
    if (!typeOnly) {
      entry.typeOnly = false;
    }
  } else if (firstSighting) {
    const owner = ownerOf(toAbs);
    const edges = outgoing.get(owner) ?? [];
    outgoing.set(owner, edges);
    edges.push(edge);
  }
}

function mergeNamespace(
  current: UsageNamespace | undefined,
  next: UsageNamespace
): UsageNamespace {
  if (current === undefined || current === "none") {
    return next;
  }
  if (next === "none" || current === next) {
    return current;
  }
  return "both";
}

export function buildDependencies(
  symbols: SurfaceSymbol[],
  edges: CrossBoundaryEdges,
  config: AnalysisConfig = ANALYSIS_CONFIG
): SurfaceDependencies {
  const used = symbols.filter(
    (symbol) =>
      symbol.exported &&
      symbol.externalReferences + symbol.externalImportSites > 0
  );
  const totalReferences = used.reduce(
    (sum, symbol) => sum + symbol.externalReferences,
    0
  );
  const accumulators = new Map<string, ConsumerAccumulator>();
  for (const symbol of used) {
    for (const consumer of symbol.consumers) {
      const accumulator = accumulators.get(consumer.boundary) ?? {
        importSites: 0,
        references: 0,
        symbols: [],
        usageNamespace: "none" as UsageNamespace,
      };
      accumulators.set(consumer.boundary, accumulator);
      accumulator.references += consumer.references;
      accumulator.importSites += consumer.importSites;
      accumulator.usageNamespace = mergeNamespace(
        accumulator.usageNamespace,
        consumer.usageNamespace
      );
      accumulator.symbols.push({
        importSites: consumer.importSites,
        references: consumer.references,
        symbolId: symbol.id,
        symbolName: symbol.name,
        usageContexts: consumer.usageContexts,
        usageNamespace: consumer.usageNamespace,
      });
    }
  }

  const consumerNames = new Set([
    ...accumulators.keys(),
    ...edges.incoming.keys(),
  ]);
  const incoming: PackageConsumer[] = [...consumerNames]
    .map((name) => {
      const accumulator = accumulators.get(name);
      const edgeEntry = edges.incoming.get(name);
      const symbolUsages = (accumulator?.symbols ?? []).sort(
        (a, b) =>
          b.references - a.references ||
          b.importSites - a.importSites ||
          a.symbolName.localeCompare(b.symbolName)
      );
      const usageNamespace =
        accumulator?.usageNamespace ?? (edgeEntry?.typeOnly ? "type" : "value");
      return {
        importSites: accumulator?.importSites ?? 0,
        moduleEdges: edgeEntry?.edges ?? [],
        package: name,
        referenceShare:
          totalReferences === 0
            ? 0
            : (accumulator?.references ?? 0) / totalReferences,
        references: accumulator?.references ?? 0,
        surfaceShare: used.length === 0 ? 0 : symbolUsages.length / used.length,
        symbols: symbolUsages,
        symbolsUsed: symbolUsages.length,
        usageNamespace,
      };
    })
    .sort(
      (a, b) =>
        b.references - a.references ||
        b.symbolsUsed - a.symbolsUsed ||
        a.package.localeCompare(b.package)
    );

  const outgoing: PackageDependency[] = [...edges.outgoing.entries()]
    .map(([name, moduleEdges]) => ({
      moduleEdges: moduleEdges.length,
      modules: moduleEdges,
      package: name,
    }))
    .sort(
      (a, b) =>
        b.moduleEdges - a.moduleEdges || a.package.localeCompare(b.package)
    );

  const [primary] = incoming;
  const averageSymbolDistribution =
    used.length === 0
      ? 0
      : used.reduce((sum, symbol) => sum + symbol.consumerPackages.length, 0) /
        used.length;

  return {
    consumerPackages: incoming.length,
    dependencyPackages: outgoing.length,
    incoming,
    outgoing,
    ...(primary && {
      primaryConsumer: {
        package: primary.package,
        referenceShare: primary.referenceShare,
        surfaceShare: primary.surfaceShare,
      },
    }),
    averageSymbolDistribution,
    shapeSignals: shapeSignals(incoming, outgoing, config),
  };
}

function shapeSignals(
  incoming: PackageConsumer[],
  outgoing: PackageDependency[],
  config: AnalysisConfig
): PackageShapeSignal[] {
  const { concentration, shape } = config.dependency;
  const signals: PackageShapeSignal[] = [];
  const [primary] = incoming;
  const concentrated =
    primary !== undefined &&
    (primary.referenceShare >= concentration.highShare ||
      primary.surfaceShare >= concentration.highShare);
  const distributed =
    primary !== undefined &&
    incoming.length >= shape.distributedMinConsumers &&
    primary.references > 0 &&
    primary.referenceShare < concentration.distributedMaxShare;

  if (incoming.length === 1) {
    signals.push("single-consumer");
  }
  if (concentrated) {
    signals.push("concentrated-consumption");
  }
  if (distributed) {
    signals.push("distributed-consumption");
  }
  if (incoming.length >= shape.highFanIn) {
    signals.push("high-fan-in");
  }
  if (outgoing.length >= shape.highFanOut) {
    signals.push("high-fan-out");
  }
  if (
    incoming.length === 1 &&
    primary !== undefined &&
    primary.references + primary.importSites + primary.moduleEdges.length > 0 &&
    !outgoing.some((dependency) => dependency.package === primary.package)
  ) {
    signals.push("one-way-satellite");
  }
  if (
    distributed &&
    incoming.length >= shape.highFanIn &&
    incoming.length > outgoing.length
  ) {
    signals.push("shared-hub");
  }
  return signals;
}
interface ConsumerAccumulator {
  importSites: number;
  references: number;
  symbols: SymbolDependencyUsage[];
  usageNamespace: UsageNamespace;
}

export function cruisedPaths(
  root: string,
  modules: readonly CruisedModule[]
): string[] {
  return modules.flatMap((mod) => [
    resolve(root, mod.source),
    ...mod.dependencies
      .filter((dep) => !(dep.coreModule || dep.couldNotResolve))
      .map((dep) => resolve(root, dep.resolved)),
  ]);
}
