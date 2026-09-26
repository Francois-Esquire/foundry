import * as fs from "node:fs";
import * as path from "node:path";
import type { Project, ts } from "ts-morph";

import { Node } from "ts-morph";
import { buildArchitecturalProfile } from "./architectural-profile";
import type { Boundary } from "./boundary";
import { findRepoRoot, resolveBoundary } from "./boundary";
import { analyzeBoundaryInteractions } from "./boundary-interactions";
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
import type { CrossBoundaryEdges } from "./dependencies";
import {
  buildDependencies,
  cruiseWorkspace,
  normalizeEdges,
} from "./dependencies";
import { analyzeEvolutionaryPressure } from "./evolutionary-pressure";
import { buildFoldPlans } from "./fold-plan";
import type { GitHistory } from "./git-history";
import { collectGitHistory } from "./git-history";
import { analyzeDependencyGravity } from "./gravity";
import { analyzeHotspots } from "./hotspots";
import { buildPlanIntelligence } from "./intelligence";
import { booleanParameterCounts, summarize } from "./local-complexity";
import { operatorSummaries } from "./operators";
import { buildOpportunities } from "./opportunities";
import { collectOutgoingImports } from "./outgoing-imports";
import type { PackageLocalReport } from "./package-local-types";
import { buildInternalizationPlans } from "./plan";
import { createProject } from "./project";
import { indexWorkspaceReferences } from "./reference-index";
import type { ExternalUsage } from "./references";
import { emptyUsage, usageFromReferences } from "./references";
import { analyzeStructuralPressure } from "./structural-pressure";
import type { CollectedSymbol } from "./symbols";
import { collectSymbols } from "./symbols";
import type {
  AnalysisProfile,
  LocalComplexityReport,
  SurfaceReport,
  SurfaceSymbol,
} from "./types";
import type {
  WorkspaceDerivedPackageFacts,
  WorkspaceSurfaceDerivation,
} from "./workspace-derive-types";
import { WORKSPACE_SURFACE_DERIVATION_SCHEMA_VERSION } from "./workspace-derive-types";

// V12.6 workspace derivation: everything a package report says about the
// package's relationship to its current environment, computed once per
// workspace from the package-local reports. One shared TypeScript program,
// one dependency-cruiser pass, one Git log, one reference index, one concept
// evidence sweep, one overlap index — then the existing V2–V8 composition
// chain per package, reading local facts from the local report and
// workspace facts from the shared inputs. No thresholds or rules live here.
//
// Invariant: package-local facts describe the package; workspace-derived
// facts describe the package's relationship to its current environment.

export interface DeriveWorkspaceOptions {
  config?: AnalysisConfig;
  now?: Date;
  profile?: AnalysisProfile;
  /** A workspace program to reuse; created from `root` when absent. */
  project?: Project;
  root?: string;
  tsconfig?: string;
}

interface PackageState {
  boundary: Boundary;
  collected: CollectedSymbol[];
  edges: CrossBoundaryEdges;
  group: ConceptSeedGroup;
  local: PackageLocalReport;
  nodesById: Map<string, Node>;
  symbols: SurfaceSymbol[];
  usage: Record<string, ExternalUsage>;
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

/** `localComplexity` with `parameters.boolean` re-measured on the shared program. */
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

export async function deriveWorkspaceSurface(
  locals: PackageLocalReport[],
  options: DeriveWorkspaceOptions = {}
): Promise<WorkspaceSurfaceDerivation> {
  const started = performance.now();
  const root = fs.realpathSync(
    options.root ? path.resolve(options.root) : findRepoRoot(process.cwd())
  );
  const config = options.config ?? ANALYSIS_CONFIG;
  const profile = options.profile ?? "full";
  const temporal = profile === "temporal";
  const now = options.now ?? new Date();
  const lap = (): (() => number) => {
    const at = performance.now();
    return () => Math.round(performance.now() - at);
  };

  let done = lap();
  const project = options.project ?? createProject(root, options.tsconfig);
  const projectMs = done();

  done = lap();
  const states: PackageState[] = [];
  for (const local of locals) {
    const boundary = resolveBoundary(root, local.package.path);
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
        state.boundary
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
  const cruised = await cruiseWorkspace(root, options.tsconfig);
  for (const state of states) {
    state.edges = normalizeEdges(root, state.boundary, cruised);
  }
  const cruiseMs = done();

  done = lap();
  const history: GitHistory = temporal
    ? {
        analyzedAt: now.toISOString(),
        available: false,
        reason: "not-collected",
        root,
      }
    : await collectGitHistory(root, { now });
  const historyMs = done();

  done = lap();
  for (const state of states) {
    state.group = prepareConceptSeeds(
      {
        boundary: state.boundary,
        surface: state.symbols,
        symbols: state.collected,
      },
      config
    );
  }
  sweepConceptEvidence(
    project,
    root,
    states.map((state) => state.group)
  );
  const conceptsMs = done();

  done = lap();
  // The monolithic analyzer resolved a seed's overlap node through a map
  // keyed by symbol id over every collected symbol, so the last symbol with
  // that id won regardless of kind: a function declared after a same-named
  // interface hid the interface from overlap generation. Reproduced as-is
  // (V12.6 changes no analyzer result); a fix belongs with a policy bump.
  const seedTargets = new Map<ts.Node, string[]>();
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
  const overlapIndex = buildConceptOverlapIndex(
    project,
    root,
    seedTargets,
    config
  );
  const overlapIndexMs = done();

  done = lap();
  const packages: Record<string, WorkspaceDerivedPackageFacts> = {};
  for (const state of states) {
    packages[state.local.package.path] = derivePackage(state, {
      config,
      history,
      overlapIndex,
      project,
    });
  }
  const packagesMs = done();

  return {
    analyzedAt: now.toISOString(),
    diagnostics: [],
    packages,
    policyVersion: ANALYSIS_POLICY_VERSION,
    profile,
    schemaVersion: WORKSPACE_SURFACE_DERIVATION_SCHEMA_VERSION,
    timing: {
      conceptsMs,
      cruiseMs,
      historyMs,
      overlapIndexMs,
      packagesMs,
      projectMs,
      referencesMs,
      symbolsMs,
      totalMs: Math.round(performance.now() - started),
    },
  };
}

interface DeriveInputs {
  config: AnalysisConfig;
  history: GitHistory;
  overlapIndex: ReturnType<typeof buildConceptOverlapIndex>;
  project: Project;
}

/** The V2–V8 composition chain, in the order `analyzeSurface` always ran it. */
function derivePackage(
  state: PackageState,
  inputs: DeriveInputs
): WorkspaceDerivedPackageFacts {
  const { project, history, overlapIndex, config } = inputs;
  const { local, boundary, symbols, edges, nodesById } = state;
  const exported = symbols.filter((symbol) => symbol.exported);
  const packagePublic = symbols.filter((symbol) => symbol.packagePublic);
  const used = packagePublic.filter(
    (symbol) => symbol.externalReferences + symbol.externalImportSites > 0
  );

  const dependencies = buildDependencies(symbols, edges, config);
  const { opportunities, ineligibleOperations } = buildOpportunities(
    boundary,
    symbols,
    dependencies,
    config
  );
  const plans = [
    ...buildFoldPlans(boundary, symbols, dependencies, opportunities, config),
    ...buildInternalizationPlans(
      project,
      boundary,
      symbols,
      opportunities,
      nodesById
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
      collectOutgoingImports(project, boundary)
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
      config
    ),
    changeRadius: analyzeChangeRadius(
      history,
      { boundary, graph: edges.graph },
      config
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
      config
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
