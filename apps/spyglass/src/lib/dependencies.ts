import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { cruise } from "dependency-cruiser";
import extractTsConfig from "dependency-cruiser/config-utl/extract-ts-config";

import type { Boundary } from "./boundary";
import {
  boundaryContains,
  expandPattern,
  FIXTURE_DIR,
  ownerBoundary,
  toPosix,
  workspacePathAliases,
  workspacePatterns,
} from "./boundary";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import { createIgnorer } from "./ignore";
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

const EXCLUDE_PATTERNS = [
  "(^|/)(node_modules|dist|build|out|coverage|\\.next|\\.turbo|\\.cache|storybook-static)(/|$)",
  `(^|/)${FIXTURE_DIR}/`,
  "\\.d\\.ts$",
  // tooling configuration (eslint.config.ts, vitest.config.ts, …) is not
  // part of a package's source dependency surface
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

/**
 * The tsconfig-paths resolution plugin only reads a tsconfig from disk, so
 * when no tsconfig is supplied the workspace source aliases are written to a
 * temporary one.
 */
function synthesizeTsconfig(root: string): {
  file: string;
  compilerOptions: { baseUrl: string; paths: Record<string, string[]> };
} {
  const paths: Record<string, string[]> = {};
  for (const [key, targets] of Object.entries(workspacePathAliases(root))) {
    paths[key] = targets.map((target) => toPosix(relative(root, target)));
  }
  const compilerOptions = { baseUrl: toPosix(root), paths };
  const dir = mkdtempSync(join(tmpdir(), "semantic-surface-"));
  const file = join(dir, "tsconfig.json");
  writeFileSync(file, JSON.stringify({ compilerOptions }));
  return { compilerOptions, file };
}

export async function collectCrossBoundaryEdges(
  root: string,
  boundary: Boundary,
  tsconfig?: string
): Promise<CrossBoundaryEdges> {
  return normalizeEdges(root, boundary, await cruiseWorkspace(root, tsconfig));
}

/**
 * One dependency-cruiser pass over every workspace entry. The raw module
 * list is boundary-free; `normalizeEdges` slices it for any boundary, so a
 * workspace derivation cruises once and slices per package.
 */
export async function cruiseWorkspace(
  root: string,
  tsconfig?: string | undefined
): Promise<CruisedModule[]> {
  const synthesized = tsconfig ? undefined : synthesizeTsconfig(root);
  const tsconfigFile = synthesized?.file ?? resolve(root, tsconfig ?? "");
  const transpileTsConfig: unknown = synthesized
    ? { options: synthesized.compilerOptions }
    : extractTsConfig(tsconfigFile);
  const patterns = workspacePatterns(root);
  const entries = (patterns.length > 0 ? patterns : [""]).flatMap((pattern) =>
    pattern === ""
      ? ["."]
      : expandPattern(root, pattern).map((dir) => toPosix(relative(root, dir)))
  );
  try {
    const result = await cruise(
      entries.filter((entry) => existsSync(resolve(root, entry))),
      {
        baseDir: root,
        doNotFollow: { path: "node_modules" },
        exclude: { path: EXCLUDE_PATTERNS },
        tsConfig: { fileName: tsconfigFile },
        tsPreCompilationDeps: true,
      },
      undefined,
      { tsConfig: transpileTsConfig }
    );
    if (typeof result.output === "string") {
      throw new Error(
        "dependency-cruiser returned an unexpected string output"
      );
    }
    return result.output.modules;
  } finally {
    if (synthesized) {
      rmSync(dirname(synthesized.file), { recursive: true });
    }
  }
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

export function normalizeEdges(
  root: string,
  boundary: Boundary,
  modules: CruisedModule[]
): CrossBoundaryEdges {
  const incoming = new Map<string, IncomingEdges>();
  const outgoing = new Map<string, ModuleDependencyEdge[]>();
  const moduleOwners = new Map<string, string>();
  // One edge object per pair, shared by the graph and the boundary lists, so
  // a later value import of an already-seen type-only pair updates both.
  const graphEdges = new Map<string, ModuleDependencyEdge>();

  // dependency-cruiser only takes regex excludes, so gitignored files are
  // dropped here instead: as modules, and as edge targets.
  const ignorer = createIgnorer(root);
  const inRoot = (absolute: string) => {
    const rel = relative(root, absolute);
    return (
      rel !== "" &&
      !rel.startsWith("..") &&
      !isAbsolute(rel) &&
      !ignorer.ignores(toPosix(rel))
    );
  };

  const registerModule = (absolute: string): string => {
    const rel = toPosix(relative(root, absolute));
    if (!moduleOwners.has(rel)) {
      moduleOwners.set(rel, ownerBoundary(root, absolute));
    }
    return rel;
  };

  normalizeEdgesMod(
    modules,
    root,
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
      root,
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
  root: string,
  fromAbs: string,
  incoming: Map<string, IncomingEdges>,
  firstSighting: boolean,
  edge: ModuleDependencyEdge,
  typeOnly: boolean,
  toAbs: string,
  outgoing: Map<string, ModuleDependencyEdge[]>
) {
  if (toIn) {
    const owner = ownerBoundary(root, fromAbs);
    const entry = incoming.get(owner) ?? { edges: [], typeOnly: true };
    incoming.set(owner, entry);
    if (firstSighting) {
      entry.edges.push(edge);
    }
    if (!typeOnly) {
      entry.typeOnly = false;
    }
  } else if (firstSighting) {
    const owner = ownerBoundary(root, toAbs);
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
        accumulator?.usageNamespace ??
        // edge-only consumers (e.g. side-effect imports) load the module
        // unless every import proved type-only
        (edgeEntry?.typeOnly ? "type" : "value");
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

/**
 * Shape signals are classification heuristics, not quality gates — the
 * underlying percentages are always reported alongside them.
 */
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
