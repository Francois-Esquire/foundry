import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import { distribution } from "./internal-topology";
import type {
  InternalConsumedSymbol,
  InternalPackageTopology,
} from "./internal-topology-types";
import type { PackageLocalReport } from "./package-local-types";
import type {
  ArchitecturalScope,
  ArchitecturalScopeKind,
  ArchitecturalScopeRef,
  DeclarationPlacement,
  DeclarationShape,
  DirectoryRelationship,
  LocalityShare,
  RegionShare,
  SymbolDistributionShape,
  SymbolLocalityFinding,
  SymbolLocalityLimitation,
  SymbolLocalityReport,
  SymbolLocalitySummary,
  SymbolUsage,
} from "./symbol-locality-types";
import { SYMBOL_LOCALITY_SCHEMA_VERSION } from "./symbol-locality-types";

// V13.1 symbol locality. A pure function of one package's local report and
// its internal topology: no file system, no program, no workspace, no Git.
// Each internally consumed symbol gets one finding describing where it is
// declared, where its consumers sit, how concentrated that is, and what the
// dependency graph and local behavior evidence say beside the path facts.
// Nothing here names a better place for anything.

const DISTRIBUTION_SHAPES: SymbolDistributionShape[] = [
  "module-localized",
  "directory-localized",
  "region-localized",
  "multi-region",
  "package-distributed",
];
const PLACEMENTS: DeclarationPlacement[] = [
  "aligned",
  "broader-than-consumers",
  "narrower-than-consumers",
  "cross-region",
  "cross-directory",
  "split",
  "distributed",
  "unclear",
];
const USAGES: SymbolUsage[] = ["type", "value", "both"];
const SHAPES: DeclarationShape[] = ["behavior", "contract", "value"];
const LIMITATIONS: SymbolLocalityLimitation[] = [
  "single-consumer",
  "namespace-member-derived",
  "namespace-bare-use",
];

function share(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

function zeroRecord<K extends string>(keys: K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

function scopeId(kind: ArchitecturalScopeKind, path: string): string {
  return `${kind}:${path}`;
}

function scopeRef(
  kind: ArchitecturalScopeKind,
  path: string
): ArchitecturalScopeRef {
  return { id: scopeId(kind, path), kind, path };
}

interface Tally {
  bindingOccurrences: number;
  importSites: number;
  modules: number;
}

function tally(
  consumers: InternalConsumedSymbol["consumers"],
  keyOf: (module: string) => string
): Map<string, Tally> {
  const tallies = new Map<string, Tally>();
  for (const consumer of consumers) {
    const key = keyOf(consumer.module);
    const entry = tallies.get(key) ?? {
      bindingOccurrences: 0,
      importSites: 0,
      modules: 0,
    };
    entry.modules += 1;
    entry.importSites += consumer.importSites + consumer.namespaceSites;
    entry.bindingOccurrences += consumer.bindingOccurrences;
    tallies.set(key, entry);
  }
  return tallies;
}

function toShares(
  tallies: Map<string, Tally>,
  totals: Tally,
  order: (a: [string, Tally], b: [string, Tally]) => number
): LocalityShare[] {
  return [...tallies.entries()].sort(order).map(([id, entry]) => ({
    bindingOccurrences: entry.bindingOccurrences,
    bindingShare: share(entry.bindingOccurrences, totals.bindingOccurrences),
    id,
    importSiteShare: share(entry.importSites, totals.importSites),
    importSites: entry.importSites,
    modules: entry.modules,
    share: share(entry.modules, totals.modules),
  }));
}

const byModulesThenSites = (a: [string, Tally], b: [string, Tally]) =>
  b[1].modules - a[1].modules ||
  b[1].importSites - a[1].importSites ||
  a[0].localeCompare(b[0]);

const byBindingsThenSites = (a: [string, Tally], b: [string, Tally]) =>
  b[1].bindingOccurrences - a[1].bindingOccurrences ||
  b[1].importSites - a[1].importSites ||
  a[0].localeCompare(b[0]);

export function analyzeSymbolLocality(
  report: PackageLocalReport,
  topology: InternalPackageTopology,
  config: AnalysisConfig = ANALYSIS_CONFIG
): SymbolLocalityReport {
  const policy = config.internalLocality;
  const prefix = report.package.path === "" ? "" : `${report.package.path}/`;
  const relative = (rootRelative: string) =>
    rootRelative.startsWith(prefix)
      ? rootRelative.slice(prefix.length)
      : rootRelative;

  const moduleById = new Map(topology.modules.map((m) => [m.id, m]));
  const directoryById = new Map(topology.directories.map((d) => [d.id, d]));
  const symbolById = new Map(report.symbols.map((s) => [s.id, s]));
  const rolesOf = new Map(topology.roles.map((r) => [r.module, r.roles]));

  // Ancestor chains from the topology's own directory tree, root first.
  const lineages = new Map<string, string[]>();
  const lineageOf = (directory: string): string[] => {
    const cached = lineages.get(directory);
    if (cached !== undefined) {
      return cached;
    }
    const parent = directoryById.get(directory)?.parent;
    const chain =
      parent === undefined ? [directory] : [...lineageOf(parent), directory];
    lineages.set(directory, chain);
    return chain;
  };
  /** The package root or a technical root: a directory above every path region. */
  const aboveRegions = (directory: string): boolean => {
    const node = directoryById.get(directory);
    if (node?.parent === undefined) {
      return true;
    }
    return node.depth === 1 && topology.policy.technicalRoots.includes(node.id);
  };
  const commonAncestor = (directories: string[]): string => {
    let common = lineageOf(directories[0] ?? ".");
    for (const directory of directories.slice(1)) {
      const chain = lineageOf(directory);
      let depth = 0;
      while (
        depth < common.length &&
        depth < chain.length &&
        common[depth] === chain[depth]
      ) {
        depth += 1;
      }
      common = common.slice(0, depth);
    }
    return common[common.length - 1] ?? ".";
  };

  const primaryModules = topology.modules
    .filter((m) => m.primary)
    .map((m) => m.id);
  const directoryScopeModules = new Map<string, string[]>();
  const regionScopeModules = new Map<string, string[]>();
  for (const id of primaryModules) {
    const module = moduleById.get(id);
    if (module === undefined) {
      continue;
    }
    for (const ancestor of lineageOf(module.directory)) {
      const list = directoryScopeModules.get(ancestor) ?? [];
      list.push(id);
      directoryScopeModules.set(ancestor, list);
    }
    const list = regionScopeModules.get(module.region) ?? [];
    list.push(id);
    regionScopeModules.set(module.region, list);
  }
  const packageId = topology.package.id;
  const scopes: ArchitecturalScope[] = [
    {
      id: scopeId("package", packageId),
      kind: "package",
      modules: primaryModules,
      path: packageId,
    },
    ...[...regionScopeModules.keys()]
      .sort((a, b) => a.localeCompare(b))
      .map<ArchitecturalScope>((region) => ({
        id: scopeId("region", region),
        kind: "region",
        modules: regionScopeModules.get(region) ?? [],
        parent: scopeId("package", packageId),
        path: region,
      })),
    ...topology.directories.map<ArchitecturalScope>((directory) => ({
      id: scopeId("directory", directory.id),
      kind: "directory",
      modules: directoryScopeModules.get(directory.id) ?? [],
      parent:
        directory.parent === undefined
          ? scopeId("package", packageId)
          : scopeId("directory", directory.parent),
      path: directory.id,
    })),
    ...primaryModules.map<ArchitecturalScope>((id) => ({
      id: scopeId("module", id),
      kind: "module",
      modules: [id],
      parent: scopeId("directory", moduleById.get(id)?.directory ?? "."),
      path: id,
    })),
  ];

  const neighbors = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    const set = neighbors.get(from) ?? new Set<string>();
    set.add(to);
    neighbors.set(from, set);
  };
  for (const edge of topology.edges) {
    if (!edge.primary) {
      continue;
    }
    link(edge.source, edge.target);
    link(edge.target, edge.source);
  }
  const consumerComponents = (consumers: string[]): number => {
    const inside = new Set(consumers);
    const seen = new Set<string>();
    let count = 0;
    for (const start of consumers) {
      if (seen.has(start)) {
        continue;
      }
      count += 1;
      seen.add(start);
      const queue = [start];
      for (const current of queue) {
        for (const next of neighbors.get(current) ?? []) {
          if (!inside.has(next) || seen.has(next)) {
            continue;
          }
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return count;
  };

  const statementsByModule = new Map<string, number>();
  const functionsBySymbol = new Map<string, number>();
  for (const fn of report.localComplexity.functions) {
    const module = relative(fn.file);
    statementsByModule.set(
      module,
      (statementsByModule.get(module) ?? 0) + fn.metrics.statements
    );
    if (fn.ownerSymbolId !== undefined) {
      functionsBySymbol.set(
        fn.ownerSymbolId,
        (functionsBySymbol.get(fn.ownerSymbolId) ?? 0) + 1
      );
    }
  }
  const seedKinds = new Set<string>(config.concepts.seedKinds);

  // Bare namespace imports between primary modules: the consumer names the
  // module, not a symbol, so any symbol declared or forwarded there may be
  // under-counted.
  const bareNamespaceTargets = new Set<string>();
  let bareNamespaceSites = 0;
  for (const site of report.imports) {
    if (site.kind !== "namespace" || site.members !== undefined) {
      continue;
    }
    if (site.scope !== "internal" || site.targetModule === undefined) {
      continue;
    }
    const source = relative(site.sourceModule);
    const target = relative(site.targetModule);
    if (source === target) {
      continue;
    }
    if (!(moduleById.get(source)?.primary && moduleById.get(target)?.primary)) {
      continue;
    }
    bareNamespaceSites += 1;
    bareNamespaceTargets.add(target);
  }
  let unresolvedDefaultImportSites = 0;
  for (const edge of topology.edges) {
    if (!edge.primary) {
      continue;
    }
    for (const symbol of edge.symbols) {
      if (symbol.name === "default" && symbol.symbolId === undefined) {
        unresolvedDefaultImportSites += symbol.importSites;
      }
    }
  }

  const findings: SymbolLocalityFinding[] = [];
  for (const consumed of topology.consumedSurface) {
    const declared = symbolById.get(consumed.symbolId);
    const declaration = moduleById.get(consumed.declarationModule);
    if (declared === undefined || declaration === undefined) {
      continue;
    }
    const consumers = consumed.consumers;
    const consumerIds = consumers.map((c) => c.module);
    const directoryOf = (module: string) =>
      moduleById.get(module)?.directory ?? ".";
    const regionOf = (module: string) => moduleById.get(module)?.region ?? ".";

    const totals: Tally = {
      bindingOccurrences: consumed.bindingOccurrences,
      importSites: consumed.importSites + consumed.namespaceSites,
      modules: consumers.length,
    };
    const [dominantModule] = toShares(
      tally(consumers, (module) => module),
      totals,
      byBindingsThenSites
    );
    const [dominantDirectory] = toShares(
      tally(consumers, directoryOf),
      totals,
      byModulesThenSites
    );
    const regions: RegionShare[] = toShares(
      tally(consumers, regionOf),
      totals,
      byModulesThenSites
    ).map((entry) => ({
      ...entry,
      significant: entry.share >= policy.significantShareThreshold,
    }));
    const [topRegion] = regions;
    if (
      dominantModule === undefined ||
      dominantDirectory === undefined ||
      topRegion === undefined
    ) {
      continue;
    }
    const dominantRegion =
      topRegion.share >= policy.dominantShareThreshold ? topRegion : undefined;
    const significantRegions = regions.filter((r) => r.significant).length;
    // Two significant regions that together would be dominant are a split;
    // two significant regions over a long tail are a distribution.
    const split =
      dominantRegion === undefined &&
      significantRegions === 2 &&
      topRegion.share + (regions[1]?.share ?? 0) >=
        policy.dominantShareThreshold;

    const commonDirectory = commonAncestor(consumerIds.map(directoryOf));
    const commonScope: ArchitecturalScopeRef =
      consumers.length === 1
        ? scopeRef("module", consumerIds[0] ?? "")
        : regions.length > 1
          ? scopeRef("package", packageId)
          : aboveRegions(commonDirectory)
            ? scopeRef("region", topRegion.id)
            : scopeRef("directory", commonDirectory);
    const declarationDirectory = declaration.directory;
    // The root and a technical root are one level: `src/types.ts` is not
    // below consumers whose common directory is `.` only because a
    // `scripts/` sits beside `src/`.
    const directoryRelationship: DirectoryRelationship =
      declarationDirectory === commonDirectory ||
      (aboveRegions(declarationDirectory) && aboveRegions(commonDirectory))
        ? "same"
        : lineageOf(commonDirectory).includes(declarationDirectory)
          ? "ancestor"
          : lineageOf(declarationDirectory).includes(commonDirectory)
            ? "descendant"
            : "disjoint";

    const distributionShape: SymbolDistributionShape =
      consumers.length === 1
        ? "module-localized"
        : consumed.consumerDirectories.length === 1
          ? "directory-localized"
          : regions.length === 1
            ? "region-localized"
            : dominantRegion !== undefined || split
              ? "multi-region"
              : "package-distributed";

    let placement: DeclarationPlacement;
    if (consumers.length < policy.minimumConsumers) {
      placement = "unclear";
    } else if (distributionShape === "package-distributed") {
      placement = "distributed";
    } else if (split || dominantRegion === undefined) {
      placement = "split";
    } else if (declaration.region === dominantRegion.id) {
      switch (directoryRelationship) {
        case "same":
          placement = "aligned";
          break;
        case "ancestor":
          placement = "broader-than-consumers";
          break;
        case "descendant":
          placement =
            significantRegions >= 2 ? "narrower-than-consumers" : "aligned";
          break;
        case "disjoint":
          placement = "cross-directory";
          break;
      }
    } else {
      placement =
        directoryRelationship === "ancestor"
          ? "broader-than-consumers"
          : "cross-region";
    }

    const crossRegion = consumers.filter(
      (c) => regionOf(c.module) !== declaration.region
    );
    const crossed = [
      ...new Set(
        crossRegion.map((c) => `${regionOf(c.module)}→${declaration.region}`)
      ),
    ].sort((a, b) => a.localeCompare(b));

    const layers = consumerIds.map((id) => moduleById.get(id)?.layer ?? 0);
    const cycleCounts = new Map<string, number>();
    let bridges = 0;
    let aggregators = 0;
    for (const id of consumerIds) {
      const cycle = moduleById.get(id)?.cycle;
      if (cycle !== undefined) {
        cycleCounts.set(cycle, (cycleCounts.get(cycle) ?? 0) + 1);
      }
      const roles = rolesOf.get(id) ?? [];
      if (roles.includes("bridge")) {
        bridges += 1;
      }
      if (roles.includes("aggregator")) {
        aggregators += 1;
      }
    }
    const [topCycle] = [...cycleCounts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    );

    const declarationFunctions = functionsBySymbol.get(consumed.symbolId) ?? 0;
    const declarationShape: DeclarationShape =
      declarationFunctions > 0
        ? "behavior"
        : declared.kind === "interface" || declared.kind === "type"
          ? "contract"
          : "value";
    const statementsByRegion = new Map<string, number>();
    let consumerStatements = 0;
    for (const id of consumerIds) {
      const statements = statementsByModule.get(id) ?? 0;
      consumerStatements += statements;
      const region = regionOf(id);
      statementsByRegion.set(
        region,
        (statementsByRegion.get(region) ?? 0) + statements
      );
    }
    const [topBehaviorRegion] = [...statementsByRegion.entries()]
      .filter(([, statements]) => statements > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const dominantBehaviorRegion =
      topBehaviorRegion === undefined
        ? undefined
        : {
            id: topBehaviorRegion[0],
            share: share(topBehaviorRegion[1], consumerStatements),
          };

    const typeOnly = consumers.filter(
      (c) => c.typeOnlySites === c.importSites + c.namespaceSites
    ).length;
    const usage: SymbolUsage =
      typeOnly === consumers.length
        ? "type"
        : consumers.every((c) => c.typeOnlySites === 0)
          ? "value"
          : "both";

    const limitations: SymbolLocalityLimitation[] = [];
    if (consumers.length === 1) {
      limitations.push("single-consumer");
    }
    if (consumers.some((c) => c.namespaceSites > 0)) {
      limitations.push("namespace-member-derived");
    }
    if (
      bareNamespaceTargets.has(consumed.declarationModule) ||
      consumers.some(
        (c) => c.via !== undefined && bareNamespaceTargets.has(c.via)
      )
    ) {
      limitations.push("namespace-bare-use");
    }

    findings.push({
      commonDirectory: {
        depth: directoryById.get(commonDirectory)?.depth ?? 0,
        path: commonDirectory,
      },
      commonScope,
      conceptSeed: seedKinds.has(declared.kind),
      consumerModules: consumerIds,
      consumers: {
        bindingOccurrences: consumed.bindingOccurrences,
        directories: consumed.consumerDirectories.length,
        importSites: consumed.importSites,
        mediated: consumers.filter((c) => c.via !== undefined).length,
        modules: consumers.length,
        namespaceSites: consumed.namespaceSites,
        regions: regions.length,
        typeOnly,
      },
      declaration: {
        depth: directoryById.get(declarationDirectory)?.depth ?? 0,
        directory: declarationDirectory,
        module: declaration.id,
        region: declaration.region,
        scope: scopeRef("directory", declarationDirectory),
      },
      directoryRelationship,
      dominantDirectory,
      dominantModule,
      exported: declared.exported,
      kind: declared.kind,
      name: consumed.name,
      packagePublic: declared.packagePublic,
      symbolId: consumed.symbolId,
      topRegion,
      usage,
      ...(dominantRegion !== undefined && { dominantRegion }),
      behavior: {
        consumerStatements,
        declarationFunctions,
        declarationShape,
        ...(dominantBehaviorRegion !== undefined && {
          agreesWithUsage: dominantBehaviorRegion.id === topRegion.id,
          dominantBehaviorRegion,
        }),
      },
      distribution: distributionShape,
      evidence:
        consumers.length === 1
          ? "limited"
          : limitations.length > 0
            ? "partial"
            : "complete",
      limitations,
      placement,
      regions,
      seams: {
        crossed,
        crossRegionConsumers: crossRegion.length,
        crossRegionShare: share(crossRegion.length, consumers.length),
      },
      significantRegions,
      structure: {
        consumerComponents: consumerComponents(consumerIds),
        layerSpan: { max: Math.max(...layers), min: Math.min(...layers) },
        ...(topCycle !== undefined && {
          cycle: {
            consumerShare: share(topCycle[1], consumers.length),
            declarationMember: declaration.cycle === topCycle[0],
            id: topCycle[0],
          },
        }),
        aggregatorConsumerShare: share(aggregators, consumers.length),
        bridgeConsumerShare: share(bridges, consumers.length),
      },
    });
  }

  const summary: SymbolLocalitySummary = {
    anonymousDefaultExports: report.defaultExports.filter(
      (entry) => entry.symbolId === undefined
    ).length,
    bareNamespaceSites,
    behaviorDisagreesWithUsage: findings.filter(
      (f) => f.behavior.agreesWithUsage === false
    ).length,
    byDeclarationShape: zeroRecord(SHAPES),
    byDistribution: zeroRecord(DISTRIBUTION_SHAPES),
    byPlacement: zeroRecord(PLACEMENTS),
    byUsage: zeroRecord(USAGES),
    conceptSeeds: findings.filter((f) => f.conceptSeed).length,
    crossSeamSymbols: findings.filter((f) => f.seams.crossed.length > 0).length,
    distributions: {
      consumerDirectories: distribution(
        findings.map((f) => f.consumers.directories)
      ),
      consumerModules: distribution(findings.map((f) => f.consumers.modules)),
      consumerRegions: distribution(findings.map((f) => f.consumers.regions)),
      topRegionShare: distribution(
        findings.map((f) => Math.round(f.topRegion.share * 100))
      ),
    },
    limitations: zeroRecord(LIMITATIONS),
    packagePublic: findings.filter((f) => f.packagePublic).length,
    symbols: findings.length,
    unresolvedDefaultImportSites,
  };
  for (const finding of findings) {
    summary.byDistribution[finding.distribution] += 1;
    summary.byPlacement[finding.placement] += 1;
    summary.byUsage[finding.usage] += 1;
    summary.byDeclarationShape[finding.behavior.declarationShape] += 1;
    for (const limitation of finding.limitations) {
      summary.limitations[limitation] += 1;
    }
  }

  return {
    limitations: [
      "intra-module usage is not measured: a symbol used only in its declaring module has no finding",
      "consumer-side concept evidence sits in the local report's participation index and is not folded into findings; only the declaration's seed kind is read here",
      "binding occurrences are syntactic identifier counts, not checker-resolved references",
    ],
    package: { ...topology.package },
    policy: {
      commonScope:
        "deepest common consumer directory; the region when that directory is the root or a technical root; the package across regions",
      dominanceDenominator: "consumer modules",
      dominantShareThreshold: policy.dominantShareThreshold,
      minimumConsumers: policy.minimumConsumers,
      significantShareThreshold: policy.significantShareThreshold,
      technicalRoots: [...topology.policy.technicalRoots],
    },
    schemaVersion: SYMBOL_LOCALITY_SCHEMA_VERSION,
    scopes,
    summary,
    symbols: findings,
  };
}

export function getSymbolLocality(
  report: SymbolLocalityReport,
  symbolId: string
): SymbolLocalityFinding | undefined {
  return report.symbols.find((finding) => finding.symbolId === symbolId);
}

/** Findings declared in the region. */
export function getSymbolsByRegion(
  report: SymbolLocalityReport,
  region: string
): SymbolLocalityFinding[] {
  return report.symbols.filter(
    (finding) => finding.declaration.region === region
  );
}

export function getSymbolsByPlacement(
  report: SymbolLocalityReport,
  placement: DeclarationPlacement
): SymbolLocalityFinding[] {
  return report.symbols.filter((finding) => finding.placement === placement);
}

export function getSymbolsByDistribution(
  report: SymbolLocalityReport,
  shape: SymbolDistributionShape
): SymbolLocalityFinding[] {
  return report.symbols.filter((finding) => finding.distribution === shape);
}
