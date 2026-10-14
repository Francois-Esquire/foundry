import type { OutgoingImportSite } from "./outgoing-imports";
import type {
  BoundaryInteraction,
  BoundaryInteractionReport,
  BoundaryInteractionTotals,
  BoundaryModuleContribution,
  ModuleDependencyEdge,
  PackageConsumer,
  SurfaceReport,
  SurfaceSymbol,
  UsageNamespace,
} from "./types";

/** The report sections boundary interaction reads. */
export type BoundarySource = Pick<
  SurfaceReport,
  "dependencies" | "summary" | "symbols" | "target"
>;

interface ModuleTally {
  importSites: number;
  moduleEdges: number;
  references: number;
  symbols: Set<string>;
}

interface NamespaceCounts {
  both: number;
  type: number;
  value: number;
}

function tally(map: Map<string, ModuleTally>, module: string): ModuleTally {
  const existing = map.get(module);
  if (existing !== undefined) {
    return existing;
  }
  const created: ModuleTally = {
    importSites: 0,
    moduleEdges: 0,
    references: 0,
    symbols: new Set(),
  };
  map.set(module, created);
  return created;
}

function tallyEdges(
  edges: ModuleDependencyEdge[],
  sources: Map<string, ModuleTally>,
  destinations: Map<string, ModuleTally>
): void {
  for (const edge of edges) {
    tally(sources, edge.fromFile).moduleEdges += 1;
    tally(destinations, edge.toFile).moduleEdges += 1;
  }
}

function contributions(
  tallies: Map<string, ModuleTally>,
  boundaryImportSites: number,
  measured: boolean
): BoundaryModuleContribution[] {
  return [...tallies.entries()]
    .map(([module, counts]) => ({
      importSites: counts.importSites,
      module,
      moduleEdges: counts.moduleEdges,
      references: measured ? counts.references : null,
      share:
        boundaryImportSites === 0
          ? 0
          : counts.importSites / boundaryImportSites,
      symbols: counts.symbols.size,
    }))
    .sort(
      (a, b) =>
        b.importSites - a.importSites ||
        (b.references ?? 0) - (a.references ?? 0) ||
        b.moduleEdges - a.moduleEdges ||
        a.module.localeCompare(b.module)
    );
}

/** Modules carrying import sites; edge-only endpoints (barrels) are listed but not counted. */
function carrying(modules: BoundaryModuleContribution[]): number {
  return modules.filter((module) => module.importSites > 0).length;
}

function namespaceOf(counts: NamespaceCounts): UsageNamespace {
  const type = counts.type > 0 || counts.both > 0;
  const value = counts.value > 0 || counts.both > 0;
  if (type && value) {
    return "both";
  }
  if (type) {
    return "type";
  }
  if (value) {
    return "value";
  }
  return "none";
}

function assemble(
  from: string,
  to: string,
  moduleEdges: number,
  importSites: number,
  symbols: BoundaryInteraction["symbols"],
  namespace: UsageNamespace,
  counts: NamespaceCounts,
  surfaceCoverage: number | null,
  sourceModules: BoundaryModuleContribution[],
  destinationModules: BoundaryModuleContribution[]
): BoundaryInteraction {
  return {
    breadth: {
      destinationModules: carrying(destinationModules),
      sourceModules: carrying(sourceModules),
    },
    concentration: {
      destinationModuleShare: destinationModules[0]?.share ?? 0,
      sourceModuleShare: sourceModules[0]?.share ?? 0,
    },
    destinationModules,
    from,
    importSites,
    moduleEdges,
    sourceModules,
    surfaceCoverage,
    symbols,
    to,
    usage: {
      bothSymbols: counts.both,
      namespace,
      typeOnlySymbols: counts.type,
      valueOnlySymbols: counts.value,
    },
  };
}

function incomingInteraction(
  source: BoundarySource,
  target: string,
  consumer: PackageConsumer,
  symbolsById: Map<string, SurfaceSymbol>
): BoundaryInteraction {
  const sources = new Map<string, ModuleTally>();
  const destinations = new Map<string, ModuleTally>();
  tallyEdges(consumer.moduleEdges, sources, destinations);
  const counts: NamespaceCounts = { both: 0, type: 0, value: 0 };
  let importSites = 0;
  let references = 0;
  let packagePublic = 0;
  for (const usage of consumer.symbols) {
    const symbol = symbolsById.get(usage.symbolId);
    if (symbol === undefined) {
      continue;
    }
    importSites += usage.importSites;
    references += usage.references;
    if (symbol.packagePublic) {
      packagePublic += 1;
    }
    if (usage.usageNamespace !== "none") {
      counts[usage.usageNamespace] += 1;
    }
    const destination = tally(destinations, symbol.declarationFile);
    destination.importSites += usage.importSites;
    destination.references += usage.references;
    destination.symbols.add(symbol.id);
    for (const moduleUsage of symbol.consumerModuleUsage) {
      if (moduleUsage.package !== consumer.package) {
        continue;
      }
      const origin = tally(sources, moduleUsage.module);
      origin.importSites += moduleUsage.importSites;
      origin.references += moduleUsage.references;
      origin.symbols.add(symbol.id);
    }
  }
  const distinct = consumer.symbols.length;
  const publicSymbols = source.summary.packagePublicSymbols;
  return assemble(
    consumer.package,
    target,
    consumer.moduleEdges.length,
    importSites,
    {
      distinct,
      packagePublic,
      references,
      referencesPerSymbol: distinct === 0 ? null : references / distinct,
    },
    consumer.usageNamespace,
    counts,
    publicSymbols === 0 ? null : packagePublic / publicSymbols,
    contributions(sources, importSites, true),
    contributions(destinations, importSites, true)
  );
}

function outgoingInteraction(
  target: string,
  dependency: string,
  edges: ModuleDependencyEdge[],
  sites: OutgoingImportSite[]
): BoundaryInteraction {
  const sources = new Map<string, ModuleTally>();
  const destinations = new Map<string, ModuleTally>();
  tallyEdges(edges, sources, destinations);
  const spaces = new Map<string, Set<"type" | "value">>();
  for (const site of sites) {
    const origin = tally(sources, site.sourceModule);
    origin.importSites += 1;
    origin.symbols.add(site.symbolKey);
    const destination = tally(destinations, site.declarationModule);
    destination.importSites += 1;
    destination.symbols.add(site.symbolKey);
    const space = spaces.get(site.symbolKey) ?? new Set();
    spaces.set(site.symbolKey, space);
    space.add(site.typeOnly || site.typeDeclaration ? "type" : "value");
  }
  const counts: NamespaceCounts = { both: 0, type: 0, value: 0 };
  for (const space of spaces.values()) {
    if (space.size === 2) {
      counts.both += 1;
    } else if (space.has("type")) {
      counts.type += 1;
    } else {
      counts.value += 1;
    }
  }
  return assemble(
    target,
    dependency,
    edges.length,
    sites.length,
    {
      distinct: spaces.size,
      packagePublic: null,
      references: null,
      referencesPerSymbol: null,
    },
    namespaceOf(counts),
    counts,
    null,
    contributions(sources, sites.length, false),
    contributions(destinations, sites.length, false)
  );
}

function totals(
  interactions: BoundaryInteraction[],
  symbols: Set<string>,
  measured: boolean
): BoundaryInteractionTotals {
  return {
    importSites: interactions.reduce((sum, edge) => sum + edge.importSites, 0),
    moduleEdges: interactions.reduce((sum, edge) => sum + edge.moduleEdges, 0),
    packages: interactions.length,
    references: measured
      ? interactions.reduce(
          (sum, edge) => sum + (edge.symbols.references ?? 0),
          0
        )
      : null,
    symbols: symbols.size,
  };
}

/**
 * Aggregates existing per-consumer symbol usage, per-module usage, module
 * edges, and the target's own import declarations into per-boundary traffic.
 * Pure composition — no scanning, no thresholds, no judgement.
 */
export function analyzeBoundaryInteractions(
  source: BoundarySource,
  outgoingImports: OutgoingImportSite[]
): BoundaryInteractionReport {
  const target = source.target.name ?? source.target.path;
  const symbolsById = new Map(
    source.symbols.map((symbol) => [symbol.id, symbol])
  );

  const incoming = source.dependencies.incoming.map((consumer) =>
    incomingInteraction(source, target, consumer, symbolsById)
  );
  const incomingSymbols = new Set(
    source.dependencies.incoming.flatMap((consumer) =>
      consumer.symbols.map((usage) => usage.symbolId)
    )
  );

  const sitesByPackage = new Map<string, OutgoingImportSite[]>();
  for (const site of outgoingImports) {
    const sites = sitesByPackage.get(site.package) ?? [];
    sitesByPackage.set(site.package, sites);
    sites.push(site);
  }
  const edgesByPackage = new Map(
    source.dependencies.outgoing.map((dependency) => [
      dependency.package,
      dependency.modules,
    ])
  );
  const dependencyNames = [
    ...new Set([...edgesByPackage.keys(), ...sitesByPackage.keys()]),
  ];
  const outgoing = dependencyNames
    .map((name) =>
      outgoingInteraction(
        target,
        name,
        edgesByPackage.get(name) ?? [],
        sitesByPackage.get(name) ?? []
      )
    )
    .sort(
      (a, b) =>
        b.importSites - a.importSites ||
        b.moduleEdges - a.moduleEdges ||
        a.to.localeCompare(b.to)
    );
  const outgoingSymbols = new Set(
    outgoingImports.map((site) => site.symbolKey)
  );

  let throughPaths = 0;
  for (const consumer of incoming) {
    for (const dependency of outgoing) {
      if (consumer.from !== dependency.to) {
        throughPaths += 1;
      }
    }
  }

  return {
    incoming,
    outgoing,
    summary: {
      incoming: totals(incoming, incomingSymbols, true),
      outgoing: totals(outgoing, outgoingSymbols, false),
      throughPaths,
    },
    target,
  };
}
