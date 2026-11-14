import type { Project, ts } from "ts-morph";

import { Node } from "ts-morph";
import { buildArchitecturalProfile } from "./architectural-profile";
import { analyzeBoundaryInteractions } from "./boundary-interactions";
import type {
  Boundary,
  BoundaryEntrypoint,
  DirectoryOwnership,
  SourceOwner,
} from "./boundary-model";
import { ownerFromDirectories } from "./boundary-model";
import { analyzeChangeCoupling } from "./change-coupling";
import { analyzeChangeRadius } from "./change-radius";
import { analyzeChurn } from "./churn";
import {
  analyzeConceptDistribution,
  attachConceptDistribution,
} from "./concept-distribution";
import { analyzeConceptBehavioralLocality } from "./concept-locality";
import {
  analyzeConceptOverlapFromIndex,
  buildConceptOverlapIndex,
} from "./concept-overlap";
import { analyzeConceptOwnership } from "./concept-ownership";
import { analyzeRecenteringCandidates } from "./concept-recentering";
import type { ConceptSeedGroup } from "./concepts";
import {
  buildConceptInventory,
  prepareConceptSeeds,
  sweepConceptEvidence,
} from "./concepts";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG, ANALYSIS_POLICY_VERSION } from "./config";
import { analyzeEvolutionaryPressure } from "./evolutionary-pressure";
import type { FoldInputs } from "./fold-planning";
import { foldOpportunity, planFolds } from "./fold-planning";
import type { GitHistory } from "./git-history";
import { analyzeDependencyGravity } from "./gravity";
import { analyzeHotspots } from "./hotspots";
import { buildPlanIntelligence } from "./intelligence";
import { booleanParameterCounts, summarize } from "./local-complexity";
import type {
  CrossBoundaryEdges,
  CruisedModule,
  ModuleGraphLookups,
} from "./module-graph";
import { buildDependencies, normalizeEdges } from "./module-graph";
import { operatorSummaries } from "./operator-summaries";
import { buildOpportunities } from "./opportunities";
import { collectOutgoingImports } from "./outgoing-imports";
import type { PackageLocalReport } from "./package-local-types";
import { buildInternalizationPlans } from "./plan";
import { indexWorkspaceReferences } from "./reference-index";
import type { ExternalUsage } from "./references";
import { emptyUsage, usageFromReferences } from "./references";
import { analyzeStructuralPressure } from "./structural-pressure";
import type { CollectedSymbol } from "./symbols";
import { collectSymbols } from "./symbols";
import type {
  AnalysisProfile,
  LocalComplexityReport,
  SurfaceDependencies,
  SurfaceReport,
  SurfaceSymbol,
} from "./types";
import type {
  WorkspaceDerivationTiming,
  WorkspaceDerivedPackageFacts,
  WorkspaceSurfaceDerivation,
} from "./workspace-derive-types";
import { WORKSPACE_SURFACE_DERIVATION_SCHEMA_VERSION } from "./workspace-derive-types";

interface PreparedWorkspacePackage {
  boundary: Boundary;

  entrypoints: BoundaryEntrypoint[];
}

export interface PreparedWorkspaceInputs {
  directories?: DirectoryOwnership;
  history: GitHistory;
  moduleGraph: {
    ignored: ReadonlyMap<string, boolean>;
    modules: CruisedModule[];
  };

  now: Date;

  ownerErrors: ReadonlyMap<string, unknown>;

  owners: ReadonlyMap<string, string>;

  packages: PreparedWorkspacePackage[];

  profile: AnalysisProfile;
  project: Project;
  root: string;
  timing: Pick<
    WorkspaceDerivationTiming,
    "cruiseMs" | "historyMs" | "projectMs"
  >;
}

interface PackageState {
  boundary: Boundary;
  collected: CollectedSymbol[];
  edges: CrossBoundaryEdges;
  entrypoints: BoundaryEntrypoint[];
  group: ConceptSeedGroup;
  local: PackageLocalReport;
  nodesById: Map<string, Node>;
  symbols: SurfaceSymbol[];
  usage: Record<string, ExternalUsage>;
}

type PackageReductions = ReturnType<typeof buildOpportunities> & {
  dependencies: SurfaceDependencies;
};

export interface WorkspaceFoldStage {
  readonly config: AnalysisConfig;
  readonly overlapIndex: ReturnType<typeof buildConceptOverlapIndex>;
  readonly ownerOf: SourceOwner;
  readonly prepared: PreparedWorkspaceInputs;
  readonly reductions: readonly PackageReductions[];
  readonly started: number;
  readonly states: readonly PackageState[];

  readonly timing: Pick<
    WorkspaceDerivationTiming,
    | "conceptsMs"
    | "overlapIndexMs"
    | "packagesMs"
    | "referencesMs"
    | "symbolsMs"
  > & { normalizeMs: number };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function ownedSymbols(
  local: PackageLocalReport,
  collected: CollectedSymbol[]
): Map<string, Node> {
  const nodesById = new Map<string, Node>();
  const localIds = new Set(local.symbols.map((symbol) => symbol.id));
  for (const symbol of collected) {
    if (!nodesById.has(symbol.id)) {
      nodesById.set(symbol.id, symbol.node);
    }
  }
  const missing = [...localIds].filter((id) => !nodesById.has(id));
  const extra = [...nodesById.keys()].filter((id) => !localIds.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `package-local report for ${local.package.path} does not match the workspace program (missing ${missing.length}: ${missing.slice(0, 3).join(", ")}; extra ${extra.length}: ${extra.slice(0, 3).join(", ")}); the local cache is stale`
    );
  }
  return nodesById;
}

export function patchBooleanParameters(
  complexity: LocalComplexityReport,
  counts: Record<string, number>
): LocalComplexityReport {
  const functions = complexity.functions.map((fn) => {
    const boolean = counts[fn.id];
    if (boolean === undefined || boolean === fn.metrics.parameters.boolean) {
      return fn;
    }
    return {
      ...fn,
      metrics: {
        ...fn.metrics,
        parameters: { ...fn.metrics.parameters, boolean },
      },
    };
  });
  const changed = functions.some((fn, i) => fn !== complexity.functions[i]);
  return changed ? { functions, summary: summarize(functions) } : complexity;
}

export function lap(): () => number {
  const at = performance.now();
  return () => Math.round(performance.now() - at);
}

export function foldRequests(stage: WorkspaceFoldStage): {
  destinations: string[];
  sources: Boundary[];
} {
  const destinations = new Set<string>();
  const sources: Boundary[] = [];
  for (const [index, state] of stage.states.entries()) {
    const reductions = stage.reductions[index] as PackageReductions;
    const target = foldOpportunity(reductions.opportunities)?.target;
    if (target !== undefined) {
      sources.push(state.boundary);
      destinations.add(target.name);
    }
  }
  return { destinations: [...destinations], sources };
}

export function analyzeWorkspaceToFolds(
  locals: readonly PackageLocalReport[],
  prepared: PreparedWorkspaceInputs,
  config: AnalysisConfig = ANALYSIS_CONFIG
): WorkspaceFoldStage {
  const started = performance.now();
  const { moduleGraph, profile, project, root } = prepared;
  const temporal = profile === "temporal";
  if (prepared.packages.length !== locals.length) {
    throw new Error(
      `prepared ${prepared.packages.length} boundaries for ${locals.length} local reports`
    );
  }
  const { directories, ownerErrors, owners } = prepared;
  if (directories !== undefined && directories.root !== root) {
    throw new Error(
      `prepared directory ownership is for ${directories.root}, not ${root}`
    );
  }
  const ownerOf: SourceOwner = (filePath) => {
    const owner = owners.get(filePath);
    if (owner !== undefined) {
      return owner;
    }
    if (ownerErrors.has(filePath)) {
      throw ownerErrors.get(filePath);
    }
    if (directories === undefined) {
      throw new Error(`No prepared owner for ${filePath}`);
    }
    return ownerFromDirectories(directories, filePath);
  };
  const lookups: ModuleGraphLookups = {
    ignores: (rel) => {
      const verdict = moduleGraph.ignored.get(rel);
      if (verdict === undefined) {
        throw new Error(`No prepared gitignore verdict for ${rel}`);
      }
      return verdict;
    },
    ownerOf,
  };

  let done = lap();
  const states: PackageState[] = [];
  for (const [index, local] of locals.entries()) {
    const { boundary, entrypoints } = prepared.packages[
      index
    ] as PreparedWorkspacePackage;
    const collected = collectSymbols(project, boundary);
    const nodesById = ownedSymbols(local, collected);
    states.push({
      boundary,
      collected,
      edges: {
        graph: { edges: [], modules: [], owners: {} },
        incoming: new Map(),
        outgoing: new Map(),
      },
      entrypoints,
      group: { boundary, byNode: new Map(), states: [] },
      local,
      nodesById,
      symbols: [],
      usage: {},
    });
  }
  const symbolsMs = done();

  done = lap();
  if (!temporal) {
    const findable = states.flatMap((state) =>
      state.local.symbols.flatMap((symbol) => {
        const node = state.nodesById.get(symbol.id);
        return symbol.exported &&
          node !== undefined &&
          Node.isReferenceFindable(node)
          ? [{ key: `${state.local.package.path}\0${symbol.id}`, node, state }]
          : [];
      })
    );
    const references = indexWorkspaceReferences(
      project,
      findable.map(({ key, node }) => ({ key, node }))
    );
    for (const { key, state } of findable) {
      const id = key.slice(state.local.package.path.length + 1);
      state.usage[id] = usageFromReferences(
        references.get(key) ?? [],
        state.boundary,
        ownerOf
      );
    }
  }
  const referencesMs = done();
  for (const state of states) {
    state.symbols = state.local.symbols.map((symbol) => ({
      declarationFile: symbol.declarationFile,
      exported: symbol.exported,
      id: symbol.id,
      kind: symbol.kind,
      name: symbol.name,
      packagePublic: symbol.packagePublic,
      ...(state.usage[symbol.id] ?? emptyUsage()),
    }));
  }

  done = lap();
  for (const state of states) {
    state.edges = normalizeEdges(
      root,
      state.boundary,
      moduleGraph.modules,
      lookups
    );
  }
  const normalizeMs = done();

  done = lap();
  for (const state of states) {
    state.group = prepareConceptSeeds(
      {
        boundary: state.boundary,
        surface: state.symbols,
        symbols: state.collected,
      },
      config,
      ownerOf
    );
  }
  sweepConceptEvidence(
    project,
    root,
    states.map((state) => state.group),
    ownerOf
  );
  const conceptsMs = done();

  done = lap();

  const visitState = () => {
    for (const state of states) {
      const target = state.boundary.packageName ?? state.boundary.relPath;
      const seedIds = new Set(state.group.states.map((seed) => seed.seed.id));
      const lastNodeById = new Map<string, ts.Node>();
      for (const symbol of state.collected) {
        if (seedIds.has(symbol.id)) {
          lastNodeById.set(symbol.id, symbol.node.compilerNode);
        }
      }
      for (const node of lastNodeById.values()) {
        const list = seedTargets.get(node) ?? [];
        list.push(target);
        seedTargets.set(node, list);
      }
    }
  };
  const seedTargets = new Map<ts.Node, string[]>();
  visitState();
  const overlapIndex = buildConceptOverlapIndex(
    project,
    root,
    seedTargets,
    config,
    ownerOf
  );
  const overlapIndexMs = done();

  done = lap();
  const reductions = states.map((state) => {
    const dependencies = buildDependencies(state.symbols, state.edges, config);
    return {
      dependencies,
      ...buildOpportunities(
        state.boundary,
        state.symbols,
        dependencies,
        config
      ),
    };
  });
  const packagesMs = done();

  return {
    config,
    overlapIndex,
    ownerOf,
    prepared,
    reductions,
    started,
    states,
    timing: {
      conceptsMs,
      normalizeMs,
      overlapIndexMs,
      packagesMs,
      referencesMs,
      symbolsMs,
    },
  };
}

export function completeWorkspace(
  stage: WorkspaceFoldStage,
  fold: FoldInputs
): WorkspaceSurfaceDerivation {
  const { config, overlapIndex, ownerOf, prepared, started, states } = stage;
  const { history, now, profile, project, root } = prepared;
  if (fold.root !== root) {
    throw new Error(`prepared fold inputs are for ${fold.root}, not ${root}`);
  }
  const done = lap();
  const packages: Record<string, WorkspaceDerivedPackageFacts> = {};
  for (const [index, state] of states.entries()) {
    packages[state.local.package.path] = derivePackage(
      state,
      stage.reductions[index] as PackageReductions,
      { config, fold, history, overlapIndex, ownerOf, project }
    );
  }
  const { conceptsMs, normalizeMs, overlapIndexMs, referencesMs, symbolsMs } =
    stage.timing;
  const packagesMs = stage.timing.packagesMs + done();

  return {
    analyzedAt: now.toISOString(),
    diagnostics: [],
    packages,
    policyVersion: ANALYSIS_POLICY_VERSION,
    profile,
    schemaVersion: WORKSPACE_SURFACE_DERIVATION_SCHEMA_VERSION,
    timing: {
      conceptsMs,
      cruiseMs: prepared.timing.cruiseMs + normalizeMs,
      historyMs: prepared.timing.historyMs,
      overlapIndexMs,
      packagesMs,
      projectMs: prepared.timing.projectMs,
      referencesMs,
      symbolsMs,

      totalMs:
        prepared.timing.projectMs +
        prepared.timing.cruiseMs +
        prepared.timing.historyMs +
        Math.round(performance.now() - started),
    },
  };
}

interface DeriveInputs {
  config: AnalysisConfig;
  fold: FoldInputs;
  history: GitHistory;
  overlapIndex: ReturnType<typeof buildConceptOverlapIndex>;
  ownerOf: SourceOwner;
  project: Project;
}

function derivePackage(
  state: PackageState,
  reductions: PackageReductions,
  inputs: DeriveInputs
): WorkspaceDerivedPackageFacts {
  const { project, history, overlapIndex, config, ownerOf, fold } = inputs;
  const { local, boundary, entrypoints, symbols, edges, nodesById } = state;
  const { dependencies, ineligibleOperations, opportunities } = reductions;
  const exported = symbols.filter((symbol) => symbol.exported);
  const packagePublic = symbols.filter((symbol) => symbol.packagePublic);
  const used = packagePublic.filter(
    (symbol) => symbol.externalReferences + symbol.externalImportSites > 0
  );

  const plans = [
    ...planFolds(boundary, symbols, dependencies, opportunities, config, fold),
    ...buildInternalizationPlans(
      project,
      boundary,
      symbols,
      opportunities,
      nodesById,
      entrypoints
    ),
  ];
  const booleanParameters = Object.fromEntries(
    booleanParameterCounts(project, boundary)
  );
  const localComplexity = patchBooleanParameters(
    local.localComplexity,
    booleanParameters
  );
  const roles = new Map(Object.entries(local.moduleRoles));

  const base: Omit<
    SurfaceReport,
    | "architecturalProfile"
    | "boundaryInteractions"
    | "structuralPressure"
    | "churn"
    | "hotspots"
    | "changeCoupling"
    | "changeRadius"
    | "evolutionaryPressure"
    | "conceptOverlap"
    | "conceptOwnership"
    | "conceptBehavioralLocality"
    | "recenteringCandidates"
  > = {
    policyVersion: ANALYSIS_POLICY_VERSION,
    schemaVersion: 35,
    target: {
      ...(local.package.name !== undefined && { name: local.package.name }),
      boundaryType: local.package.boundaryType,
      path: local.package.path,
    },
    ...(local.anchor !== undefined && { anchor: local.anchor }),
    conceptInventory: buildConceptInventory(state.group, symbols),
    dependencies,
    dependencyGravity: analyzeDependencyGravity(edges.graph, boundary, roles),
    ineligibleOperations,
    localComplexity,
    operators: operatorSummaries(opportunities, plans),
    opportunities,
    plans,
    summary: {
      declaredSurfaceRatio: ratio(packagePublic.length, symbols.length),
      exportUtilization: ratio(used.length, packagePublic.length),
      externallyUsedSymbols: used.length,
      externalSurfaceRatio: ratio(used.length, symbols.length),
      moduleExportedSymbols: exported.length,
      moduleOnlyExports: exported.length - packagePublic.length,
      packagePublicSymbols: packagePublic.length,
      totalSymbols: symbols.length,
      unusedExternalExports: packagePublic.length - used.length,
    },
    symbols,
  };
  const composed = {
    ...base,
    architecturalProfile: buildArchitecturalProfile(base, config),
    boundaryInteractions: analyzeBoundaryInteractions(
      base,
      collectOutgoingImports(project, boundary, ownerOf)
    ),
  };
  const evolving = {
    ...composed,
    churn: analyzeChurn(history, boundary, config),
    structuralPressure: analyzeStructuralPressure(composed, config),
  };
  const historical = {
    ...evolving,
    changeCoupling: analyzeChangeCoupling(
      history,
      { boundary, graph: edges.graph },
      config,
      ownerOf
    ),
    changeRadius: analyzeChangeRadius(
      history,
      { boundary, graph: edges.graph },
      config,
      ownerOf
    ),
    hotspots: analyzeHotspots(evolving, config),
  };
  const evolved = {
    ...historical,
    evolutionaryPressure: analyzeEvolutionaryPressure(historical, config),
  };
  attachConceptDistribution(
    evolved.conceptInventory,
    analyzeConceptDistribution(evolved.conceptInventory, evolved, config)
  );
  const overlapping = {
    ...evolved,
    conceptOverlap: analyzeConceptOverlapFromIndex(
      overlapIndex,
      {
        boundary,
        changeCoupling: evolved.changeCoupling,
        conceptInventory: evolved.conceptInventory,
      },
      config
    ),
  };
  const owned = {
    ...overlapping,
    conceptOwnership: analyzeConceptOwnership(
      { ...overlapping, boundary, project },
      config,
      ownerOf
    ),
  };
  const localized = {
    ...owned,
    conceptBehavioralLocality: analyzeConceptBehavioralLocality(
      { ...owned, boundary, graph: edges.graph },
      config
    ),
  };
  const report: SurfaceReport = {
    ...localized,
    recenteringCandidates: analyzeRecenteringCandidates(localized, config),
  };
  for (const plan of report.plans) {
    plan.intelligence = buildPlanIntelligence(plan, report);
  }

  return {
    architecturalProfile: report.architecturalProfile,
    booleanParameters,
    boundaryInteractions: report.boundaryInteractions,
    changeCoupling: report.changeCoupling,
    changeRadius: report.changeRadius,
    churn: report.churn,
    conceptBehavioralLocality: report.conceptBehavioralLocality,
    conceptInventory: report.conceptInventory,
    conceptOverlap: report.conceptOverlap,
    conceptOwnership: report.conceptOwnership,
    dependencies: report.dependencies,
    dependencyGravity: report.dependencyGravity,
    evolutionaryPressure: report.evolutionaryPressure,
    hotspots: report.hotspots,
    ineligibleOperations: report.ineligibleOperations,
    operators: report.operators,
    opportunities: report.opportunities,
    path: local.package.path,
    plans: report.plans,
    recenteringCandidates: report.recenteringCandidates,
    structuralPressure: report.structuralPressure,
    summary: {
      exportUtilization: report.summary.exportUtilization,
      externallyUsedSymbols: report.summary.externallyUsedSymbols,
      externalSurfaceRatio: report.summary.externalSurfaceRatio,
      unusedExternalExports: report.summary.unusedExternalExports,
    },
    usage: state.usage,
  };
}
