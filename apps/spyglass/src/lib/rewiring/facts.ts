import type { AnalysisConfig } from "../config";
import type { InternalResponsibilityReport } from "../internal-responsibility-types";
import type {
  CompositionEvidence,
  CompositionRoleKind,
} from "../internal-rewiring-types";
import type {
  InternalModuleEdge,
  InternalModuleNode,
  InternalPackageTopology,
} from "../internal-topology-types";
import type {
  PackageLocalBindingUses,
  PackageLocalImport,
  PackageLocalReport,
} from "../package-local-types";
import type {
  ArchitecturalRole,
  ArchitecturalRoleFinding,
  ArchitecturalScopeClass,
  ConventionDimension,
  PrimitiveConventionReport,
} from "../primitive-convention-types";
import type { SymbolLocalityReport } from "../symbol-locality-types";
import { EMPTY_USES, sorted, USE_KEYS, WIRING_ROLES } from "./common";
export function createRewiringFacts(
  local: PackageLocalReport,
  topology: InternalPackageTopology,
  locality: SymbolLocalityReport,
  responsibilities: InternalResponsibilityReport,
  primitives: PrimitiveConventionReport,
  config: AnalysisConfig
) {
  const policy = config.internalRewiring;
  const { root } = responsibilities.package;
  const prefix = root === "" || root === "." ? "" : `${root}/`;
  const packageRelative = (file: string) =>
    file.startsWith(prefix) ? file.slice(prefix.length) : file;
  // Shared indexes.
  const moduleNode = new Map(topology.modules.map((m) => [m.id, m]));
  const primaryModules = topology.modules.filter((m) => m.primary);
  const primaryEdges = topology.edges.filter((e) => e.primary);
  const edgesBySource = new Map<string, InternalModuleEdge[]>();
  const edgesByTarget = new Map<string, InternalModuleEdge[]>();
  const visitEdge = (edge: InternalModuleEdge) => {
    edgesBySource.set(edge.source, [
      ...(edgesBySource.get(edge.source) ?? []),
      edge,
    ]);
    edgesByTarget.set(edge.target, [
      ...(edgesByTarget.get(edge.target) ?? []),
      edge,
    ]);
    edgeByKey.set(`${edge.source}→${edge.target}`, edge);
  };
  const edgeByKey = new Map<string, InternalModuleEdge>();
  for (const edge of primaryEdges) {
    visitEdge(edge);
  }
  const moduleEvidence = new Map(
    responsibilities.modules.map((m) => [m.module, m])
  );
  const regionOf = (module: string): string | undefined =>
    moduleEvidence.get(module)?.region;
  const regionById = new Map(responsibilities.regions.map((r) => [r.id, r]));
  const ambiguityOf = new Map(
    responsibilities.unresolved.map((u) => [u.module, u.reason])
  );
  const findingById = new Map(primitives.symbols.map((s) => [s.symbolId, s]));
  const visitFinding5 = (finding: ArchitecturalRoleFinding) => {
    const list = findingsByModule.get(finding.declaration.module) ?? [];
    list.push(finding);
    findingsByModule.set(finding.declaration.module, list);
  };
  const findingsByModule = new Map<string, ArchitecturalRoleFinding[]>();
  for (const finding of primitives.symbols) {
    visitFinding5(finding);
  }
  const moduleFinding = new Map(primitives.modules.map((m) => [m.module, m]));
  const localityById = new Map(locality.symbols.map((s) => [s.symbolId, s]));
  const declarationById = new Map(
    local.declarations.map((d) => [d.symbolId, d])
  );
  const packagePublic = new Set(
    local.symbols.filter((s) => s.packagePublic).map((s) => s.id)
  );
  const consumersOf = new Map(
    topology.consumedSurface.map((entry) => [entry.symbolId, entry.consumers])
  );
  const cycleById = new Map(topology.cycles.map((c) => [c.id, c]));
  const conventionById = new Map(primitives.conventions.map((c) => [c.id, c]));
  const conventionGroup = (
    role: ArchitecturalRole,
    scope: ArchitecturalScopeClass,
    dimension: ConventionDimension
  ) =>
    primitives.conventionGroups.find(
      (g) => g.role === role && g.scope === scope
    )?.dimensions[dimension];
  const classifyEdge = (
    source: string,
    target: string
  ): "within" | "cross" | "unresolved" => {
    const a = regionOf(source);
    const b = regionOf(target);
    if (a === undefined || b === undefined) {
      return "unresolved";
    }
    return a === b ? "within" : "cross";
  };
  const reaches = (from: string, goal: (module: string) => boolean) => {
    const seen = new Set<string>([from]);
    const queue = [from];
    while (queue.length > 0) {
      const current = queue.shift() ?? "";
      for (const edge of edgesBySource.get(current) ?? []) {
        if (seen.has(edge.target)) {
          continue;
        }
        if (goal(edge.target)) {
          return true;
        }
        seen.add(edge.target);
        queue.push(edge.target);
      }
    }
    return false;
  };
  /** Whether `module` still sits in a nontrivial SCC of its cycle once `removed` edges are gone. */
  const stillCyclic = (module: string, removed: Set<string>) => {
    const cycleId = moduleNode.get(module)?.cycle;
    const cycle = cycleId === undefined ? undefined : cycleById.get(cycleId);
    if (cycle === undefined) {
      return false;
    }
    const members = new Set(cycle.modules);
    const next = (m: string) =>
      (edgesBySource.get(m) ?? [])
        .filter(
          (e) =>
            members.has(e.target) && !removed.has(`${e.source}→${e.target}`)
        )
        .map((e) => e.target);
    const seen = new Set<string>();
    const queue = next(module);
    while (queue.length > 0) {
      const current = queue.shift() ?? "";
      if (current === module) {
        return true;
      }
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      queue.push(...next(current));
    }
    return false;
  };
  const visitSite = (site: PackageLocalImport) => {
    if (site.uses === undefined || site.targetModule === undefined) {
      return;
    }
    const key = `${packageRelative(site.sourceModule)}→${packageRelative(site.targetModule)}`;
    const total = usesBySourceTarget.get(key) ?? { ...EMPTY_USES };
    for (const use of USE_KEYS) {
      total[use] += site.uses[use];
    }
    usesBySourceTarget.set(key, total);
  };
  // Composition evidence: how each primary module consumes the
  // responsibilities it depends on, from its import bindings' uses.
  const usesBySourceTarget = new Map<string, PackageLocalBindingUses>();
  for (const site of local.imports) {
    visitSite(site);
  }
  const compositionByModule = new Map<string, CompositionEvidence>();
  for (const node of primaryModules) {
    recordCompositionEvidence(node, {
      ambiguityOf,
      compositionByModule,
      edgesBySource,
      local,
      moduleEvidence,
      policy,
      regionOf,
      usesBySourceTarget,
    });
  }
  const isRoot = (module: string) =>
    compositionByModule.get(module)?.compositionRoot === true;
  return {
    ambiguityOf,
    classifyEdge,
    compositionByModule,
    consumersOf,
    conventionById,
    conventionGroup,
    cycleById,
    declarationById,
    edgeByKey,
    edgesBySource,
    edgesByTarget,
    findingById,
    findingsByModule,
    isRoot,
    local,
    locality,
    localityById,
    moduleEvidence,
    moduleFinding,
    moduleNode,
    packagePublic,
    packageRelative,
    policy,
    prefix,
    primaryEdges,
    primaryModules,
    primitives,
    reaches,
    regionById,
    regionOf,
    responsibilities,
    root,
    stillCyclic,
    topology,
    usesBySourceTarget,
    visitEdge,
    visitFinding5,
    visitSite,
  };
}
export type RewiringFacts = ReturnType<typeof createRewiringFacts>;
function recordCompositionEvidence(
  node: InternalModuleNode,
  index: Pick<
    RewiringFacts,
    | "regionOf"
    | "edgesBySource"
    | "usesBySourceTarget"
    | "local"
    | "moduleEvidence"
    | "policy"
    | "ambiguityOf"
    | "compositionByModule"
  >
) {
  const own = index.regionOf(node.id);
  const targets = index.edgesBySource.get(node.id) ?? [];
  const reached = new Set<string>();
  let unresolvedTargets = 0;
  const wiring = { ...EMPTY_USES };
  const wiredBy: Record<keyof PackageLocalBindingUses, Set<string>> = {
    argument: new Set(),
    called: new Set(),
    collected: new Set(),
    constructed: new Set(),
    rendered: new Set(),
  };
  const visitEdge2 = (edge: InternalModuleEdge) => {
    const region = index.regionOf(edge.target);
    if (region === undefined) {
      unresolvedTargets += 1;
    } else if (region !== own) {
      reached.add(region);
    }
    const uses = index.usesBySourceTarget.get(`${edge.source}→${edge.target}`);
    if (uses === undefined) {
      return;
    }
    for (const use of USE_KEYS) {
      wiring[use] += uses[use];
      if (uses[use] > 0 && region !== undefined && region !== own) {
        wiredBy[use].add(region);
      }
    }
  };
  for (const edge of targets) {
    visitEdge2(edge);
  }
  const isAggregator =
    index.local.moduleRoles[node.id]?.kind === "aggregator" ||
    (index.moduleEvidence.get(node.id)?.roles ?? []).includes("aggregator");
  const evidence: string[] = [];
  const roles: CompositionRoleKind[] = [];
  const minimumWired =
    index.policy.compositionRoot.minimumWiredResponsibilities;
  const union = (keys: (keyof PackageLocalBindingUses)[]) =>
    new Set(keys.flatMap((key) => [...wiredBy[key]]));
  classifyCompositionRoles(
    isAggregator,
    roles,
    evidence,
    reached,
    union,
    minimumWired,
    wiring,
    wiredBy,
    node,
    index.policy
  );
  if (roles.length === 0) {
    roles.push(
      index.ambiguityOf.get(node.id) === "wide-dependent"
        ? "unclear"
        : "ordinary-dependency"
    );
  }
  const wiredResponsibilities = sorted(
    union(["constructed", "called", "argument", "collected", "rendered"])
  );
  const wiringSites =
    wiring.constructed +
    wiring.called +
    wiring.argument +
    wiring.collected +
    wiring.rendered;
  const wiringRole = roles.some((role) => WIRING_ROLES.includes(role));
  const compositionRoot =
    wiringRole &&
    reached.size >= index.policy.compositionRoot.minimumResponsibilities &&
    node.exportedSymbols <=
      index.policy.compositionRoot.maximumExportedSymbols &&
    wiringSites >= index.policy.compositionRoot.minimumWiringSites &&
    wiredResponsibilities.length >= minimumWired;
  if (compositionRoot) {
    evidence.push(
      `depends on ${reached.size} responsibilities, exports ${node.exportedSymbols}, ${wiringSites} wiring sites`
    );
  }
  const evidenceEntry = index.moduleEvidence.get(node.id);
  index.compositionByModule.set(node.id, {
    module: node.id,
    status: evidenceEntry?.status ?? "unresolved",
    ...(own !== undefined && { responsibility: own }),
    ...(index.ambiguityOf.has(node.id) && {
      ambiguity: index.ambiguityOf.get(node.id),
    }),
    behaviorMass: evidenceEntry?.behaviorMass ?? 0,
    compositionRoot,
    declaredSymbols: node.declaredSymbols,
    evidence,
    exportedSymbols: node.exportedSymbols,
    fanIn: node.fanIn,
    fanOut: node.fanOut,
    providedSymbols: node.providedSymbols,
    responsibilities: sorted(reached),
    roles,
    unresolvedTargets,
    wiredResponsibilities,
    wiring,
  });
}
function classifyCompositionRoles(
  isAggregator: boolean,
  roles: CompositionRoleKind[],
  evidence: string[],
  reached: Set<string>,
  union: (keys: (keyof PackageLocalBindingUses)[]) => Set<string>,
  minimumWired: number,
  wiring: {
    argument: number;
    called: number;
    collected: number;
    constructed: number;
    rendered: number;
  },
  wiredBy: Record<keyof PackageLocalBindingUses, Set<string>>,
  node: InternalModuleNode,
  policy: {
    compositionRoot: {
      minimumResponsibilities: number;
      maximumExportedSymbols: number;
      minimumWiringSites: number;
      minimumWiredResponsibilities: number;
    };
    orchestration: {
      maximumExportedSymbols: number;
    };
    split: {
      minimumGroupSymbols: number;
    };
    alignment: {
      minimumSupportRatio: number;
    };
    closure: {
      largeShare: number;
    };
    indirection: {
      maximumProviders: number;
      maximumExportedSymbols: number;
      maximumStatements: number;
    };
    surface: {
      minimumTargetModules: number;
      minimumSymbols: number;
    };
    contract: {
      minimumSymbols: number;
    };
    candidateModules: number;
    report: {
      topScenarios: number;
      topModules: number;
    };
  }
) {
  if (isAggregator) {
    roles.push("aggregation");
    evidence.push("syntactic aggregator");
  } else if (reached.size >= 2) {
    const constructed = union(["constructed", "rendered"]);
    if (constructed.size >= minimumWired) {
      roles.push("composition");
      evidence.push(
        `constructs or renders ${wiring.constructed + wiring.rendered} bindings from ${constructed.size} responsibilities`
      );
    }
    if (wiredBy.collected.size >= minimumWired) {
      roles.push("registration");
      evidence.push(
        `collects ${wiring.collected} bindings from ${wiredBy.collected.size} responsibilities`
      );
    }
    if (
      wiredBy.called.size >= minimumWired &&
      node.exportedSymbols <= policy.orchestration.maximumExportedSymbols
    ) {
      roles.push("orchestration");
      evidence.push(
        `calls ${wiring.called} bindings from ${wiredBy.called.size} responsibilities, exports ${node.exportedSymbols}`
      );
    }
    if (wiredBy.argument.size >= minimumWired) {
      roles.push("provision");
      evidence.push(
        `passes ${wiring.argument} bindings from ${wiredBy.argument.size} responsibilities into calls`
      );
    }
  }
}
