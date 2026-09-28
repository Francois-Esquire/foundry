import { createHash } from "node:crypto";

import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type {
  InternalResponsibilityReport,
  ResponsibilityAmbiguityReason,
  ResponsibilityModuleEvidence,
  ResponsibilityRegion,
  ResponsibilityRelationship,
} from "./internal-responsibility-types";
import type {
  BeforeAfter,
  CandidateSource,
  ClosureRelationship,
  ClosureSize,
  CompositionEvidence,
  CompositionRoleKind,
  ConventionAlignment,
  CurrentArrangement,
  CycleOutcome,
  InternalRewiringEffects,
  InternalRewiringReport,
  InternalRewiringScenario,
  InternalRewiringScenarioKind,
  InternalRewiringSummary,
  LocalityRelation,
  ProposedArrangement,
  RewiringPreservation,
  RoleGroup,
  ScenarioCandidate,
  ScenarioEligibility,
  ScenarioFamily,
  ScenarioProvenance,
  ScenarioSubject,
  ScenarioSubjectKind,
  ScenarioUncertainty,
  ScenarioUncertaintyReason,
  ScopeGroup,
  SymbolMovementClosure,
  TargetEvidence,
} from "./internal-rewiring-types";
import { INTERNAL_REWIRING_SCHEMA_VERSION } from "./internal-rewiring-types";
import type {
  InternalModuleEdge,
  InternalModuleNode,
  InternalPackageTopology,
  InternalSymbolConsumer,
} from "./internal-topology-types";
import type {
  PackageLocalBindingUses,
  PackageLocalImport,
  PackageLocalReport,
} from "./package-local-types";
import type {
  ArchitecturalRole,
  ArchitecturalRoleFinding,
  ArchitecturalScopeClass,
  ConventionDimension,
  ConventionStatus,
  PlacementConvention,
  PrimitiveConventionReport,
  PrimitiveModuleFinding,
} from "./primitive-convention-types";
import type {
  DeclarationPlacement,
  SymbolLocalityReport,
} from "./symbol-locality-types";
import type { ConceptRelationshipKind } from "./types";

const splitScenarioPattern = /^responsibility-local:/;

// V13.4 internal rewiring scenarios. A pure function of the five
// package-intelligence reports: no file system, no program, no workspace.
// Candidates come from V13.3 findings (a local symbol declared elsewhere, a
// broad symbol declared narrowly, a mixed module, a deep dependency, a thin
// intermediary); each kind has explicit eligibility; each scenario carries
// its current arrangement, an architectural target, simulated effects over
// the affected subgraph, what it preserves, and what stays uncertain. A
// broad primitive or a composition root gets a preservation scenario, not
// a move. Nothing here ranks; V13.5 compares.

const KINDS: InternalRewiringScenarioKind[] = [
  "preserve-current",
  "demote-primitive",
  "colocate-primitive",
  "promote-primitive",
  "split-module-by-responsibility",
  "split-module-by-role",
  "align-with-convention",
  "formalize-cross-responsibility-contract",
  "formalize-responsibility-surface",
  "redirect-internal-dependency",
  "collapse-indirection",
  "preserve-package-primitive",
  "preserve-composition-root",
  "preserve-cross-responsibility-contract",
];

const PRESERVING_KINDS: InternalRewiringScenarioKind[] = [
  "preserve-current",
  "preserve-package-primitive",
  "preserve-composition-root",
  "preserve-cross-responsibility-contract",
];

const KIND_DEFINITIONS: Record<InternalRewiringScenarioKind, string> = {
  "align-with-convention":
    "symbols placed against a strong dedicated-role-module convention of their role and scope; place them in a dedicated-role module of the same scope",
  "collapse-indirection":
    "a thin intermediary with one consumer, one or more providers, no contract, and no concept; let the consumer depend on the providers",
  "colocate-primitive":
    "a responsibility-local symbol declared in an unresolved module; place it within the responsibility it serves",
  "demote-primitive":
    "a responsibility-local symbol declared in a module placed in another responsibility; place it within the responsibility it serves",
  "formalize-cross-responsibility-contract":
    "contract-family symbols consumed across a responsibility relationship while declared beside behavior; expose them through an explicit contract surface of the owning responsibility",
  "formalize-responsibility-surface":
    "one responsibility reaching several deep modules of another; expose a coherent internal surface of the target responsibility",
  "preserve-composition-root":
    "a module whose role is wiring several responsibilities; keep it, and keep its breadth",
  "preserve-cross-responsibility-contract":
    "a contract-family symbol shared by a few responsibilities and owned by one of them or by a hub; keep it",
  "preserve-current": "the baseline for every subject with a scenario",
  "preserve-package-primitive":
    "a package-wide symbol; keep its broad scope where it is",
  "promote-primitive":
    "a cross-responsibility or package-wide symbol declared inside one placed responsibility; place it at the scope its consumers span",
  "redirect-internal-dependency":
    "the consumer edges that would follow a placement scenario: the same symbols, imported from their responsibility",
  "split-module-by-responsibility":
    "a mixed-scope module; separate its responsibility-local groups, keeping cross-responsibility and package-wide groups together",
  "split-module-by-role":
    "a mixed-role, single-scope module in a package that separates those roles elsewhere; group its exported symbols by role",
};

const ELIGIBILITY: Record<InternalRewiringScenarioKind, string> = {
  "align-with-convention":
    "an exception to a dedicated-role-module convention (single qualifying value) whose support is at least the ratio times its exceptions; the declaring module is not itself a split subject for that role",
  "collapse-indirection":
    "a primary module with one consumer, at least one provider, few exports, little behavior, no declared concept, no cycle, and no contract, adapter, or implementation role",
  "colocate-primitive":
    "scope responsibility-local; declaring module unresolved; consumer evidence complete or partial",
  "demote-primitive":
    "scope responsibility-local; declaring module assigned or attached to a different responsibility; consumer evidence complete or partial",
  "formalize-cross-responsibility-contract":
    "a responsibility relationship carrying at least the minimum contract-family symbols declared in modules that also export behavior",
  "formalize-responsibility-surface":
    "a responsibility relationship reaching at least the minimum distinct target modules with at least the minimum symbols",
  "preserve-composition-root": "meets every composition-root criterion",
  "preserve-cross-responsibility-contract":
    "scope cross-responsibility; contract-family role; declared in an unresolved module, a dedicated-role module, or a consuming responsibility",
  "preserve-current": "any subject with at least one other scenario",
  "preserve-package-primitive": "scope package-wide",
  "promote-primitive":
    "scope cross-responsibility or package-wide; declaring module placed; at least two consumer responsibilities other than the declaring one",
  "redirect-internal-dependency":
    "an eligible demote or colocate scenario with at least one consumer edge",
  "split-module-by-responsibility":
    "module mixed-scope; at least one responsibility-local group at or above the minimum group size",
  "split-module-by-role":
    "module mixed-role with one scope group; at least two role groups at or above the minimum; an observed dedicated-role-module convention for one of those roles at that scope",
};

const COMPOSITION_ROLES: CompositionRoleKind[] = [
  "composition",
  "registration",
  "orchestration",
  "provision",
  "aggregation",
  "ordinary-dependency",
  "unclear",
];

const COMPOSITION_ROLE_DEFINITIONS: Record<CompositionRoleKind, string> = {
  aggregation: "a syntactic aggregator",
  composition:
    "constructs or renders bindings from at least the minimum wired responsibilities",
  orchestration:
    "calls bindings from at least the minimum wired responsibilities while exporting at most the orchestration maximum",
  "ordinary-dependency":
    "fewer than two responsibilities depended on, or none of the wiring shapes across them",
  provision:
    "passes bindings from at least the minimum wired responsibilities into calls",
  registration:
    "places bindings from at least the minimum wired responsibilities in object or array literals",
  unclear:
    "an unresolved wide-dependent module without wiring evidence across responsibilities",
};

const SUBJECT_KINDS: ScenarioSubjectKind[] = [
  "symbol-group",
  "module",
  "responsibility-relationship",
  "internal-dependency",
];

const ALIGNMENTS: ConventionAlignment[] = [
  "matches-convention",
  "differs-from-convention",
  "competing-convention",
  "no-applicable-convention",
];

const CYCLE_OUTCOMES: CycleOutcome[] = [
  "none",
  "unchanged",
  "membership-removed",
  "potential-new-cycle",
];

const CLOSURE_SIZES: ClosureSize[] = [
  "independent",
  "small",
  "large",
  "unresolved",
];

const PRESERVATIONS: RewiringPreservation[] = [
  "symbol-identity",
  "module-identity",
  "responsibility-ownership",
  "package-wide-scope",
  "cross-responsibility-contract",
  "composition-role",
  "public-exposure",
  "cycle-atomicity",
];

const UNCERTAINTIES: ScenarioUncertaintyReason[] = [
  "unresolved-consumers",
  "package-public-external-impact",
  "namespace-identity-gap",
  "composition-role-unclear",
  "movement-closure-incomplete",
  "large-closure",
  "closure-blocked",
  "closure-crosses-groups",
  "cycle-membership",
  "composition-root-membership",
  "target-module-unresolved",
  "internal-anchors-unavailable",
];

const CONTRACT_FAMILY: ArchitecturalRole[] = [
  "contract",
  "type",
  "representation",
  "identifier",
  "configuration",
  "schema",
  "constant",
];

const EXECUTABLE_ROLES: ArchitecturalRole[] = [
  "factory",
  "adapter",
  "implementation",
  "behavior",
  "utility",
];

const STRUCTURAL_ROLES: ArchitecturalRole[] = [
  "contract",
  "adapter",
  "implementation",
];

/** Roles whose symbols an existing module can plausibly host by role alone. */
const HOSTABLE_ROLES: ArchitecturalRole[] = [...CONTRACT_FAMILY, "utility"];

const WIRING_ROLES: CompositionRoleKind[] = [
  "composition",
  "registration",
  "orchestration",
  "provision",
];

const USE_KEYS: (keyof PackageLocalBindingUses)[] = [
  "constructed",
  "called",
  "argument",
  "collected",
  "rendered",
];

const EMPTY_USES: PackageLocalBindingUses = {
  argument: 0,
  called: 0,
  collected: 0,
  constructed: 0,
  rendered: 0,
};

const RELATIONSHIP_KINDS: ConceptRelationshipKind[] = [
  "implements",
  "extends",
  "alias",
  "type-reference",
  "parameter-type",
  "return-type",
  "property-type",
  "constructs",
];

function zeroRecord<K extends string>(keys: K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function increment<K extends string>(
  record: Partial<Record<K, number>>,
  key: K
): void {
  record[key] = (record[key] ?? 0) + 1;
}

function sortedPartial<K extends string>(
  record: Partial<Record<K, number>>
): Partial<Record<K, number>> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b))
  ) as Partial<Record<K, number>>;
}

function roleCounts(
  findings: ArchitecturalRoleFinding[]
): Partial<Record<ArchitecturalRole, number>> {
  const counts: Partial<Record<ArchitecturalRole, number>> = {};
  for (const finding of findings) {
    increment(counts, finding.primaryRole);
  }
  return sortedPartial(counts);
}

function scenarioId(
  kind: InternalRewiringScenarioKind,
  referencedSubjectIds: string[],
  target: string
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([kind, sorted(referencedSubjectIds), target]))
    .digest("hex")
    .slice(0, 12);
  return `${kind}:${hash}`;
}

function subjectIds(subject: ScenarioSubject): string[] {
  if (subject.symbolIds !== undefined) {
    return subject.symbolIds;
  }
  if (subject.relationship !== undefined) {
    return [`${subject.relationship.from}→${subject.relationship.to}`];
  }
  if (subject.edges !== undefined) {
    return subject.edges.map((edge) => `${edge.source}→${edge.target}`);
  }
  return subject.module === undefined ? [] : [subject.module];
}

function same(value: number): BeforeAfter {
  return { after: value, before: value };
}

function scopeGroupKey(finding: ArchitecturalRoleFinding): string {
  return finding.scope === "responsibility-local"
    ? `responsibility-local:${finding.served?.responsibility ?? ""}`
    : finding.scope;
}

function scopeGroups(findings: ArchitecturalRoleFinding[]): ScopeGroup[] {
  const groups = new Map<string, ArchitecturalRoleFinding[]>();
  for (const finding of findings) {
    const key = scopeGroupKey(finding);
    const list = groups.get(key) ?? [];
    list.push(finding);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map<ScopeGroup>(([key, members]) => {
      const [first] = members;
      return {
        key,
        scope: first?.scope ?? "unclear",
        ...(first?.served !== undefined &&
          first.scope === "responsibility-local" && {
            responsibility: first.served.responsibility,
          }),
        roles: roleCounts(members),
        symbolIds: sorted(members.map((m) => m.symbolId)),
      };
    })
    .sort(
      (a, b) =>
        b.symbolIds.length - a.symbolIds.length || a.key.localeCompare(b.key)
    );
}

function roleGroups(findings: ArchitecturalRoleFinding[]): RoleGroup[] {
  const groups = new Map<ArchitecturalRole, string[]>();
  for (const finding of findings) {
    const list = groups.get(finding.primaryRole) ?? [];
    list.push(finding.symbolId);
    groups.set(finding.primaryRole, list);
  }
  return [...groups.entries()]
    .map(([role, ids]) => ({ role, symbolIds: sorted(ids) }))
    .sort(
      (a, b) =>
        b.symbolIds.length - a.symbolIds.length || a.role.localeCompare(b.role)
    );
}

export function analyzeInternalRewiring(
  local: PackageLocalReport,
  topology: InternalPackageTopology,
  locality: SymbolLocalityReport,
  responsibilities: InternalResponsibilityReport,
  primitives: PrimitiveConventionReport,
  config: AnalysisConfig = ANALYSIS_CONFIG
): InternalRewiringReport {
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
    analyzeInternalRewiringEntries4(
      regionOf,
      node,
      edgesBySource,
      usesBySourceTarget,
      local,
      moduleEvidence,
      policy,
      ambiguityOf,
      compositionByModule
    );
  }
  const isRoot = (module: string) =>
    compositionByModule.get(module)?.compositionRoot === true;

  // Movement closure over declaration-level facts.
  const localDependencies = (
    symbolId: string
  ): { symbolId: string; relationship: ClosureRelationship }[] => {
    const declaration = declarationById.get(symbolId);
    const finding = findingById.get(symbolId);
    if (declaration === undefined || finding === undefined) {
      return [];
    }
    const { module } = finding.declaration;
    const inModule = (id: string) =>
      findingById.get(id)?.declaration.module === module && id !== symbolId;
    const deps: { symbolId: string; relationship: ClosureRelationship }[] = [];
    if (
      declaration.annotation !== undefined &&
      inModule(declaration.annotation)
    ) {
      deps.push({
        relationship: "annotation",
        symbolId: declaration.annotation,
      });
    }
    for (const id of declaration.typeQueries ?? []) {
      if (inModule(id)) {
        deps.push({ relationship: "type-query", symbolId: id });
      }
    }
    if (
      declaration.callee?.symbolId !== undefined &&
      inModule(declaration.callee.symbolId)
    ) {
      deps.push({
        relationship: "callee",
        symbolId: declaration.callee.symbolId,
      });
    }
    const visitConcept = () => {
      for (const concept of declaration.concepts) {
        if (!inModule(concept.conceptId)) {
          continue;
        }
        for (const kind of RELATIONSHIP_KINDS) {
          if ((concept.relationships[kind] ?? 0) > 0) {
            deps.push({ relationship: kind, symbolId: concept.conceptId });
          }
        }
      }
    };
    visitConcept();
    return deps;
  };
  const closureOf = (
    group: string[],
    module: string
  ): SymbolMovementClosure => {
    const moving = new Set(group);
    const all = findingsByModule.get(module) ?? [];
    const staying = all.filter((f) => !moving.has(f.symbolId));
    const dependsOn = new Map<string, Map<string, Set<ClosureRelationship>>>();
    for (const finding of all) {
      const byTarget = new Map<string, Set<ClosureRelationship>>();
      for (const dep of localDependencies(finding.symbolId)) {
        const set = byTarget.get(dep.symbolId) ?? new Set();
        set.add(dep.relationship);
        byTarget.set(dep.symbolId, set);
      }
      dependsOn.set(finding.symbolId, byTarget);
    }
    const required = new Map<string, Set<ClosureRelationship>>();
    const optional = new Map<string, Set<ClosureRelationship>>();
    const blockers = new Map<
      string,
      SymbolMovementClosure["blockers"][number]["reason"]
    >();
    const usedByStaying = (id: string) =>
      staying.some((f) => dependsOn.get(f.symbolId)?.has(id) ?? false);
    const queue = [...group];
    const visited = new Set<string>();
    closureOfEntries(
      queue,
      visited,
      dependsOn,
      moving,
      findingById,
      optional,
      usedByStaying,
      blockers,
      required
    );
    const visitFinding2 = () => {
      for (const finding of staying) {
        if (required.has(finding.symbolId)) {
          continue;
        }
        const deps = dependsOn.get(finding.symbolId);
        if (
          deps !== undefined &&
          [...deps.keys()].some((id) => moving.has(id))
        ) {
          blockers.set(finding.symbolId, "reverse-dependency");
        }
      }
    };
    visitFinding2();
    const entries = (map: Map<string, Set<ClosureRelationship>>) =>
      [...map.entries()]
        .map(([symbolId, kinds]) => ({
          relationships: [...kinds].sort(),
          symbolId,
        }))
        .sort((a, b) => a.symbolId.localeCompare(b.symbolId));
    const pulled = group.length + required.size + optional.size;
    let size: ClosureSize;
    if (blockers.size > 0) {
      size = "unresolved";
    } else if (required.size + optional.size === 0) {
      size = "independent";
    } else if (
      all.length > 0 &&
      pulled / all.length >= policy.closure.largeShare
    ) {
      size = "large";
    } else {
      size = "small";
    }
    return {
      blockers: [...blockers.entries()]
        .map(([symbolId, reason]) => ({ reason, symbolId }))
        .sort((a, b) => a.symbolId.localeCompare(b.symbolId)),
      optional: entries(optional),
      required: entries(required),
      size,
      subject: sorted(group),
    };
  };

  const alignmentOf = (
    role: ArchitecturalRole,
    scope: ArchitecturalScopeClass,
    dimension: ConventionDimension,
    matching: string[]
  ): { alignment: ConventionAlignment; ids: string[] } => {
    const group = conventionGroup(role, scope, dimension);
    if (group === undefined || group.status === "insufficient-evidence") {
      return { alignment: "no-applicable-convention", ids: [] };
    }
    if (group.status === "competing") {
      return { alignment: "competing-convention", ids: group.conventions };
    }
    const id = group.conventions[0] ?? "";
    const value = conventionById.get(id)?.value ?? "";
    return {
      alignment: matching.includes(value)
        ? "matches-convention"
        : "differs-from-convention",
      ids: [id],
    };
  };

  const dominantRole = (findings: ArchitecturalRoleFinding[]) =>
    roleGroups(findings)[0]?.role ?? "unknown";

  const dedicatedModulesIn = (
    region: string,
    roles: Set<ArchitecturalRole>
  ): PrimitiveModuleFinding[] =>
    (regionById.get(region)?.modules ?? [])
      .map((m) => moduleFinding.get(m))
      .filter((m): m is PrimitiveModuleFinding => m !== undefined)
      .filter(
        (m) =>
          m.composition.roles === "single-role" &&
          m.composition.dominantRole !== undefined &&
          roles.has(m.composition.dominantRole.role)
      );

  const candidateModulesFor = (
    group: ArchitecturalRoleFinding[],
    region: string | undefined,
    scope: ArchitecturalScopeClass
  ): ProposedArrangement["candidateModules"] => {
    const roles = new Set(
      group.map((f) => f.primaryRole).filter((r) => HOSTABLE_ROLES.includes(r))
    );
    const found = new Map<string, Set<TargetEvidence>>();
    const add = (module: string, evidence: TargetEvidence) => {
      if (group.some((f) => f.declaration.module === module)) {
        return;
      }
      const set = found.get(module) ?? new Set();
      set.add(evidence);
      found.set(module, set);
    };
    if (region === undefined) {
      candidateModulesForModule(
        primitives,
        findingsByModule,
        scope,
        roles,
        add
      );
    } else {
      const members = regionById.get(region)?.modules ?? [];
      if (members.length === 1 && members[0] !== undefined) {
        add(members[0], "only-module-in-responsibility");
      }
      for (const module of dedicatedModulesIn(region, roles)) {
        add(module.module, "dedicated-role-module");
        add(module.module, "same-responsibility");
        const convention = conventionGroup(
          module.composition.dominantRole?.role ?? "unknown",
          scope,
          "module"
        );
        if (
          convention?.status === "convention" &&
          conventionById.get(convention.conventions[0] ?? "")?.value ===
            "dedicated-role-module"
        ) {
          add(module.module, "matching-convention");
        }
      }
      const visitFinding = (currentMembers: string[]) => {
        for (const finding of group) {
          for (const concept of declarationById.get(finding.symbolId)
            ?.concepts ?? []) {
            const declaring = findingById.get(concept.conceptId)?.declaration
              .module;
            if (declaring !== undefined && currentMembers.includes(declaring)) {
              add(declaring, "same-concept");
            }
          }
        }
      };
      visitFinding(members);
    }
    return [...found.entries()]
      .map(([module, evidence]) => ({ evidence: [...evidence].sort(), module }))
      .sort(
        (a, b) =>
          b.evidence.length - a.evidence.length ||
          a.module.localeCompare(b.module)
      )
      .slice(0, policy.candidateModules);
  };
  /**
   * Move `group` (declared in `module`) toward `targetRegion` (undefined:
   * a shared scope with no responsibility). Consumer edges lose the group's
   * symbols; edges carrying nothing else disappear; each consumer gains an
   * edge to the target unless the target is that consumer itself.
   */
  const simulateMove = (
    group: ArchitecturalRoleFinding[],
    module: string,
    targetRegion: string | undefined,
    targetModule: string | undefined,
    before: LocalityRelation,
    after: LocalityRelation,
    conventions: InternalRewiringEffects["conventions"]
  ): MoveSimulation =>
    simulateMoveEntries3(
      group,
      consumersOf,
      module,
      edgeByKey,
      classifyEdge,
      targetModule,
      regionOf,
      targetRegion,
      closureOf,
      moduleNode,
      stillCyclic,
      reaches,
      moduleFinding,
      findingsByModule,
      conventions,
      after,
      before,
      primaryModules
    );

  const noEffects = (
    module: string | undefined,
    symbols: number,
    relationLocality: LocalityRelation,
    conventions: InternalRewiringEffects["conventions"] = {
      alignment: "no-applicable-convention",
      conventionIds: [],
    }
  ): InternalRewiringEffects => {
    const node = module === undefined ? undefined : moduleNode.get(module);
    const finding =
      module === undefined ? undefined : moduleFinding.get(module);
    const exported = (
      module === undefined ? [] : (findingsByModule.get(module) ?? [])
    ).filter((f) => f.exported && f.primaryRole !== "unknown");
    return {
      conventions,
      cycles:
        node?.cycle === undefined
          ? { membership: [], outcome: "none" }
          : { membership: [node.cycle], outcome: "unchanged" },
      dependencies: {
        edgesAdded: 0,
        edgesRemoved: 0,
        edgesRetargeted: 0,
        modules:
          node === undefined
            ? []
            : [
                {
                  fanIn: same(node.fanIn),
                  fanOut: same(node.fanOut),
                  module: node.id,
                },
              ],
      },
      locality: { after: relationLocality, before: relationLocality, symbols },
      moduleComposition: {
        module: module ?? "",
        modules: same(primaryModules.length),
        roleGroups: same(new Set(exported.map((f) => f.primaryRole)).size),
        scopeGroups: same(finding?.composition.scopeGroups ?? 0),
      },
      responsibilityBoundaries: {
        crossEdges: same(0),
        crossingSymbols: same(0),
        responsibilitiesTouched: [],
        unresolvedEdges: same(0),
        withinEdges: same(0),
      },
    };
  };

  const localityOf = (finding: ArchitecturalRoleFinding): LocalityRelation => {
    if (finding.scope === "responsibility-local") {
      if (!finding.declaration.placed) {
        return "declared-in-unresolved-module";
      }
      return finding.served?.declarationAgrees === true
        ? "declared-in-serving-responsibility"
        : "declared-outside-serving-responsibility";
    }
    if (
      finding.scope === "cross-responsibility" ||
      finding.scope === "package-wide"
    ) {
      if (!finding.declaration.placed) {
        return "declared-at-shared-scope";
      }
      return finding.consumers.responsibilities.includes(
        finding.declaration.responsibility ?? ""
      )
        ? "declared-in-one-serving-responsibility"
        : "declared-outside-serving-responsibility";
    }
    return "not-applicable";
  };

  const symbolUncertainties = (
    group: ArchitecturalRoleFinding[],
    module: string,
    closure: SymbolMovementClosure | undefined,
    movement: boolean,
    targetKnown: boolean
  ): ScenarioUncertainty[] => {
    const out: ScenarioUncertainty[] = [];
    const unresolved = group.reduce(
      (n, f) => n + f.consumers.unresolvedModules,
      0
    );
    if (unresolved > 0) {
      out.push({
        detail: `${unresolved} consumer modules outside any responsibility`,
        reason: "unresolved-consumers",
      });
    }
    const publicOnes = group.filter((f) => packagePublic.has(f.symbolId));
    if (publicOnes.length > 0) {
      out.push({
        detail: `${publicOnes.length} package-public symbols; external surface impact not evaluated in package-local analysis`,
        reason: "package-public-external-impact",
      });
    }
    if (group.some((f) => f.limitations.includes("namespace-derived"))) {
      out.push({
        detail: "some consumer evidence is a namespace member access",
        reason: "namespace-identity-gap",
      });
    }
    const composition = compositionByModule.get(module);
    if (composition?.roles.includes("unclear")) {
      out.push({
        detail: `${module} is wide-dependent without wiring evidence`,
        reason: "composition-role-unclear",
      });
    }
    symbolUncertaintiesEntries(
      movement,
      group,
      findingsByModule,
      module,
      out,
      closure,
      moduleNode,
      isRoot,
      targetKnown
    );
    return out;
  };

  const provenanceOf = (
    group: ArchitecturalRoleFinding[],
    modules: string[],
    edges: { source: string; target: string }[],
    regions: (string | undefined)[],
    conventionIds: string[]
  ): ScenarioProvenance => ({
    locality: sorted(
      group.filter((f) => localityById.has(f.symbolId)).map((f) => f.symbolId)
    ),
    primitives: sorted([
      ...group.map((f) => f.symbolId),
      ...modules,
      ...conventionIds,
    ]),
    responsibilities: sorted(
      regions.filter((r): r is string => r !== undefined)
    ),
    topology: sorted([
      ...modules,
      ...edges.map((e) => `${e.source}→${e.target}`),
      ...modules.flatMap((m) => {
        const cycle = moduleNode.get(m)?.cycle;
        return cycle === undefined ? [] : [cycle];
      }),
    ]),
  });

  // Scenario construction.
  const scenarios: InternalRewiringScenario[] = [];
  const candidates: ScenarioCandidate[] = [];
  const familyByKey = new Map<
    string,
    { subject: ScenarioSubject; ids: string[] }
  >();
  const push = (scenario: InternalRewiringScenario) => {
    scenarios.push(scenario);
    const family = familyByKey.get(scenario.subject.key) ?? {
      ids: [],
      subject: scenario.subject,
    };
    family.ids.push(scenario.id);
    familyByKey.set(scenario.subject.key, family);
  };
  const candidate = (
    source: CandidateSource,
    kind: InternalRewiringScenarioKind,
    subject: ScenarioSubject,
    eligibility: ScenarioEligibility,
    scenario?: InternalRewiringScenario
  ) => {
    candidates.push({
      eligibility,
      kind,
      source,
      subject,
      ...(scenario !== undefined && { scenarioId: scenario.id }),
    });
    if (scenario !== undefined) {
      push(scenario);
    }
  };
  const eligible = (reasons: string[]): ScenarioEligibility => ({
    eligible: true,
    missingEvidence: [],
    reasons,
  });
  const visitFinding3 = (finding: ArchitecturalRoleFinding) => {
    if (!finding.exported) {
      return;
    }
    let target: string | undefined;
    if (finding.scope === "responsibility-local") {
      if (finding.served?.declarationAgrees !== false) {
        return;
      }
      target = finding.served.responsibility;
    } else if (
      finding.scope === "cross-responsibility" ||
      finding.scope === "package-wide"
    ) {
      target = finding.scope;
    } else {
      return;
    }
    const key = `${finding.declaration.module}|${target}`;
    const group = grouped.get(key) ?? {
      members: [],
      module: finding.declaration.module,
      target,
    };
    group.members.push(finding);
    grouped.set(key, group);
  };
  const ineligible = (
    reasons: string[],
    missing: string[]
  ): ScenarioEligibility => ({
    eligible: false,
    missingEvidence: missing,
    reasons,
  });

  const currentOfGroup = (
    group: ArchitecturalRoleFinding[],
    module: string
  ): CurrentArrangement => {
    const evidence = moduleEvidence.get(module);
    const placements: Partial<Record<DeclarationPlacement, number>> = {};
    for (const finding of group) {
      if (finding.locality !== undefined) {
        increment(placements, finding.locality.placement);
      }
    }
    const [first] = group;
    return {
      module,
      moduleStatus: evidence?.status ?? "unresolved",
      ...(evidence?.region !== undefined && {
        responsibility: evidence.region,
      }),
      roles: roleCounts(group),
      ...(first !== undefined && { scope: first.scope }),
      consumerModules: new Set(
        group.flatMap((f) =>
          (consumersOf.get(f.symbolId) ?? []).map((c) => c.module)
        )
      ).size,
      consumerResponsibilities: sorted(
        group.flatMap((f) => f.consumers.responsibilities)
      ),
      placements: sortedPartial(placements),
      unresolvedConsumers: group.reduce(
        (n, f) => n + f.consumers.unresolvedModules,
        0
      ),
      ...(first !== undefined && { locality: localityOf(first) }),
      ...(isRoot(module) && {
        compositionRoles: compositionByModule.get(module)?.roles ?? [],
      }),
    };
  };

  const factsOfGroup = (group: ArchitecturalRoleFinding[]): string[] => {
    const [first] = group;
    if (first === undefined) {
      return [];
    }
    const consumers = new Set(
      group.flatMap((f) =>
        (consumersOf.get(f.symbolId) ?? []).map((c) => c.module)
      )
    ).size;
    const responsibilitiesServed = new Set(
      group.flatMap((f) => f.consumers.responsibilities)
    ).size;
    const unresolved = group.reduce(
      (n, f) => n + f.consumers.unresolvedModules,
      0
    );
    const evidence = group.every((f) => f.evidence.scope === "complete")
      ? "complete"
      : "partial";
    return [
      `${group.length} ${first.scope} symbols · ${Object.entries(
        roleCounts(group)
      )
        .map(([role, n]) => `${n} ${role}`)
        .join(", ")}`,
      `${consumers} consumer modules in ${responsibilitiesServed} responsibilities${unresolved > 0 ? ` (+${unresolved} unresolved)` : ""} · ${evidence} evidence`,
      `declaring module ${first.declaration.status}${first.declaration.responsibility === undefined ? "" : ` in ${first.declaration.responsibility}`}${ambiguityOf.has(first.declaration.module) ? ` (${ambiguityOf.get(first.declaration.module) ?? ""})` : ""}`,
    ];
  };
  const preserveCurrent = (
    subject: ScenarioSubject,
    current: CurrentArrangement,
    group: ArchitecturalRoleFinding[],
    module: string | undefined,
    preservations: RewiringPreservation[],
    provenance: ScenarioProvenance
  ): InternalRewiringScenario => ({
    current,
    effects: noEffects(
      module,
      group.length,
      current.locality ?? "not-applicable"
    ),
    id: scenarioId("preserve-current", subjectIds(subject), "unchanged"),
    kind: "preserve-current",
    preservations,
    proposed: {
      candidateModules: [],
      exactPath: "deferred",
      scope: "unchanged",
    },
    provenance,
    rationale: { facts: ["baseline: nothing moves"], sources: [] },
    subject,
    uncertainties: [],
  });
  const visitConvention = (convention: PlacementConvention) => {
    if (
      convention.scope === "any" ||
      convention.dimension !== "module" ||
      convention.value !== "dedicated-role-module" ||
      convention.exceptions.symbols === 0
    ) {
      return;
    }
    const { scope } = convention;
    const group = conventionGroup(convention.role, scope, "module");
    if (group?.status !== "convention") {
      return;
    }
    const strong =
      convention.support.symbols >=
      policy.alignment.minimumSupportRatio * convention.exceptions.symbols;
    const byModule = new Map<string, ArchitecturalRoleFinding[]>();
    for (const id of convention.exceptions.symbolIds) {
      const finding = findingById.get(id);
      if (finding === undefined) {
        continue;
      }
      const list = byModule.get(finding.declaration.module) ?? [];
      list.push(finding);
      byModule.set(finding.declaration.module, list);
    }
    analyzeInternalRewiringEntries2(
      byModule,
      convention,
      scope,
      regionOf,
      candidateModulesFor,
      currentOfGroup,
      provenanceOf,
      strong,
      candidate,
      ineligible,
      policy,
      roleSplitModules,
      consumersOf,
      findingsByModule,
      closureOf,
      noEffects,
      localityOf,
      push,
      preserveCurrent,
      eligible,
      primaryModules,
      packagePublic,
      factsOfGroup,
      symbolUncertainties
    );
  };

  // Symbol groups: by declaring module and target.
  const grouped = new Map<
    string,
    { module: string; target: string; members: ArchitecturalRoleFinding[] }
  >();
  for (const finding of primitives.symbols) {
    visitFinding3(finding);
  }

  analyzeInternalRewiringEntries5(
    grouped,
    currentOfGroup,
    factsOfGroup,
    regionOf,
    packagePublic,
    symbolUncertainties,
    preserveCurrent,
    push,
    candidateModulesFor,
    dominantRole,
    alignmentOf,
    simulateMove,
    localityOf,
    provenanceOf,
    isRoot,
    candidate,
    eligible,
    primaryModules,
    noEffects,
    primitives,
    ineligible
  );

  // Modules: splits, composition roots, indirection.
  const roleSplitModules = new Set<string>();
  for (const finding of primitives.modules) {
    analyzeInternalRewiringEntries3(
      finding,
      findingsByModule,
      regionOf,
      compositionByModule,
      moduleNode,
      preserveCurrent,
      isRoot,
      push,
      provenanceOf,
      policy,
      findingById,
      candidateModulesFor,
      dominantRole,
      alignmentOf,
      simulateMove,
      localityOf,
      closureOf,
      localDependencies,
      edgeByKey,
      primaryModules,
      symbolUncertainties,
      candidate,
      ineligible,
      eligible,
      conventionGroup,
      conventionById,
      roleSplitModules,
      noEffects,
      edgesByTarget,
      edgesBySource,
      moduleEvidence,
      classifyEdge,
      reaches,
      packagePublic
    );
  }

  // Convention outliers: exceptions to a strong dedicated-role-module
  // convention of their role and scope, grouped by declaring module.
  for (const convention of primitives.conventions) {
    visitConvention(convention);
  }

  // Responsibility relationships: surfaces and contracts.
  const crossingSymbolsOf = (relationship: ResponsibilityRelationship) => {
    const ids = new Set<string>();
    for (const source of relationship.sourceModules) {
      for (const target of relationship.targetModules) {
        const edge = edgeByKey.get(`${source}→${target}`);
        for (const symbol of edge?.symbols ?? []) {
          if (symbol.symbolId !== undefined) {
            ids.add(symbol.symbolId);
          }
        }
      }
    }
    return sorted(ids);
  };
  for (const relationship of [...responsibilities.relationships].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
  )) {
    analyzeInternalRewiringEntries(
      relationship,
      crossingSymbolsOf,
      findingById,
      edgeByKey,
      moduleFinding,
      regionById,
      policy,
      preserveCurrent,
      push,
      provenanceOf,
      candidate,
      eligible,
      responsibilities,
      primaryModules,
      ineligible,
      dominantRole,
      alignmentOf,
      packagePublic
    );
  }

  // Order and summarize.
  const kindIndex = (kind: InternalRewiringScenarioKind) => KINDS.indexOf(kind);
  scenarios.sort(
    (a, b) =>
      a.subject.key.localeCompare(b.subject.key) ||
      kindIndex(a.kind) - kindIndex(b.kind) ||
      a.id.localeCompare(b.id)
  );
  candidates.sort(
    (a, b) =>
      a.subject.key.localeCompare(b.subject.key) ||
      kindIndex(a.kind) - kindIndex(b.kind)
  );
  const scenarioById = new Map(scenarios.map((s) => [s.id, s]));
  const families: ScenarioFamily[] = [...familyByKey.values()]
    .map((family) => {
      const ids = family.ids
        .map((id) => scenarioById.get(id))
        .filter((s): s is InternalRewiringScenario => s !== undefined)
        .sort(
          (a, b) =>
            kindIndex(a.kind) - kindIndex(b.kind) || a.id.localeCompare(b.id)
        )
        .map((s) => s.id);
      return {
        preservationOnly: ids.every((id) =>
          PRESERVING_KINDS.includes(
            scenarioById.get(id)?.kind ?? "preserve-current"
          )
        ),
        scenarioIds: ids,
        subject: family.subject,
      };
    })
    .sort((a, b) => a.subject.key.localeCompare(b.subject.key));

  const composition = [...compositionByModule.values()].sort((a, b) =>
    a.module.localeCompare(b.module)
  );

  const summary = summarize(
    scenarios,
    candidates,
    families,
    composition,
    responsibilities
  );

  return {
    candidates,
    composition,
    families,
    limitations: [
      "no internal anchor model: an intentional boundary cannot be told from an incidental one, so every movement scenario carries that uncertainty",
      "movement closure reads declaration-level relationships (annotations, typeof queries, callees, concept relationships); references inside function bodies are not measured",
      "a package-public symbol's external consumers are outside the package boundary; their impact is not evaluated",
      "composition evidence is syntactic: how internal import bindings are used, not what the calls do",
      "package anchors protect the package boundary, not internal placement, and are not used here",
      "effects are simulated over the affected subgraph from canonical topology; no source is read or written",
    ],
    package: responsibilities.package,
    policy: {
      alignment: policy.alignment,
      candidateModules: policy.candidateModules,
      closure: policy.closure,
      compositionRoleDefinitions: COMPOSITION_ROLE_DEFINITIONS,
      compositionRoles: COMPOSITION_ROLES,
      compositionRoot: policy.compositionRoot,
      contract: policy.contract,
      eligibility: ELIGIBILITY,
      identity:
        "sha256 over the kind, the sorted subject ids, and the proposed target",
      indirection: policy.indirection,
      kindDefinitions: KIND_DEFINITIONS,
      kinds: KINDS,
      orchestration: policy.orchestration,
      order: "subject key, then kind order with preserve-current first",
      ranking: "none",
      split: policy.split,
      surface: policy.surface,
      targets:
        "architectural scope and existing candidate modules; exact paths deferred",
    },
    scenarios,
    schemaVersion: INTERNAL_REWIRING_SCHEMA_VERSION,
    summary,
  };
}

function analyzeInternalRewiringEntries5(
  grouped: Map<
    string,
    { module: string; target: string; members: ArchitecturalRoleFinding[] }
  >,
  currentOfGroup: (
    group: ArchitecturalRoleFinding[],
    module: string
  ) => CurrentArrangement,
  factsOfGroup: (group: ArchitecturalRoleFinding[]) => string[],
  regionOf: (module: string) => string | undefined,
  packagePublic: Set<string>,
  symbolUncertainties: (
    group: ArchitecturalRoleFinding[],
    module: string,
    closure: SymbolMovementClosure | undefined,
    movement: boolean,
    targetKnown: boolean
  ) => ScenarioUncertainty[],
  preserveCurrent: (
    subject: ScenarioSubject,
    current: CurrentArrangement,
    group: ArchitecturalRoleFinding[],
    module: string | undefined,
    preservations: RewiringPreservation[],
    provenance: ScenarioProvenance
  ) => InternalRewiringScenario,
  push: (scenario: InternalRewiringScenario) => void,
  candidateModulesFor: (
    group: ArchitecturalRoleFinding[],
    region: string | undefined,
    scope: ArchitecturalScopeClass
  ) => ProposedArrangement["candidateModules"],
  dominantRole: (findings: ArchitecturalRoleFinding[]) => ArchitecturalRole,
  alignmentOf: (
    role: ArchitecturalRole,
    scope: ArchitecturalScopeClass,
    dimension: ConventionDimension,
    matching: string[]
  ) => { alignment: ConventionAlignment; ids: string[] },
  simulateMove: (
    group: ArchitecturalRoleFinding[],
    module: string,
    targetRegion: string | undefined,
    targetModule: string | undefined,
    before: LocalityRelation,
    after: LocalityRelation,
    conventions: InternalRewiringEffects["conventions"]
  ) => MoveSimulation,
  localityOf: (finding: ArchitecturalRoleFinding) => LocalityRelation,
  provenanceOf: (
    group: ArchitecturalRoleFinding[],
    modules: string[],
    edges: { source: string; target: string }[],
    regions: (string | undefined)[],
    conventionIds: string[]
  ) => ScenarioProvenance,
  isRoot: (module: string) => boolean,
  candidate: (
    source: CandidateSource,
    kind: InternalRewiringScenarioKind,
    subject: ScenarioSubject,
    eligibility: ScenarioEligibility,
    scenario?: InternalRewiringScenario
  ) => void,
  eligible: (reasons: string[]) => ScenarioEligibility,
  primaryModules: InternalModuleNode[],
  noEffects: (
    module: string | undefined,
    symbols: number,
    relationLocality: LocalityRelation,
    conventions?: InternalRewiringEffects["conventions"]
  ) => InternalRewiringEffects,
  primitives: PrimitiveConventionReport,
  ineligible: (reasons: string[], missing: string[]) => ScenarioEligibility
) {
  for (const [key, { module, target, members }] of [...grouped.entries()].sort(
    ([a], [b]) => a.localeCompare(b)
  )) {
    const group = members.sort((a, b) => a.symbolId.localeCompare(b.symbolId));
    const [first] = group;
    if (first === undefined) {
      continue;
    }
    const subject: ScenarioSubject = {
      key,
      kind: "symbol-group",
      module,
      symbolIds: group.map((f) => f.symbolId),
    };
    const current = currentOfGroup(group, module);
    const facts = factsOfGroup(group);
    const declaringRegion = regionOf(module);
    const basePreservations: RewiringPreservation[] = [
      "symbol-identity",
      ...(group.some((f) => packagePublic.has(f.symbolId))
        ? (["public-exposure"] as RewiringPreservation[])
        : []),
    ];
    const publicUncertainty = symbolUncertainties(
      group,
      module,
      undefined,
      false,
      true
    );
    let baseline: InternalRewiringScenario | undefined;
    const ensureBaseline = (provenance: ScenarioProvenance) => {
      if (baseline !== undefined) {
        return;
      }
      baseline = preserveCurrent(
        subject,
        current,
        group,
        module,
        [
          "module-identity",
          ...basePreservations,
          ...(declaringRegion === undefined
            ? []
            : (["responsibility-ownership"] as RewiringPreservation[])),
        ],
        provenance
      );
      push(baseline);
    };

    if (first.scope === "responsibility-local") {
      analyzeInternalRewiringEntries5Entries4(
        first,
        candidateModulesFor,
        group,
        target,
        dominantRole,
        alignmentOf,
        simulateMove,
        module,
        localityOf,
        provenanceOf,
        declaringRegion,
        ensureBaseline,
        current,
        subject,
        basePreservations,
        isRoot,
        facts,
        symbolUncertainties,
        candidate,
        eligible,
        push,
        preserveCurrent,
        primaryModules,
        publicUncertainty
      );
      continue;
    }

    // Cross-responsibility and package-wide groups.
    if (
      first.scope !== "cross-responsibility" &&
      first.scope !== "package-wide"
    ) {
      continue;
    }
    const { scope } = first;
    const source: CandidateSource = scope;
    const foreign = sorted(
      group.flatMap((f) =>
        f.consumers.responsibilities.filter((r) => r !== declaringRegion)
      )
    );
    const noConvention = {
      alignment: "no-applicable-convention" as const,
      conventionIds: [],
    };
    if (scope === "package-wide") {
      const provenance = provenanceOf(
        group,
        [module],
        [],
        [declaringRegion],
        []
      );
      ensureBaseline(provenance);
      candidate(
        source,
        "preserve-package-primitive",
        subject,
        eligible([
          `package-wide: ${foreign.length} responsibilities consume the group`,
        ]),
        {
          current,
          effects: noEffects(
            module,
            group.length,
            localityOf(first),
            noConvention
          ),
          id: scenarioId(
            "preserve-package-primitive",
            subject.symbolIds ?? [],
            "package-wide"
          ),
          kind: "preserve-package-primitive",
          preservations: [
            "module-identity",
            "package-wide-scope",
            ...basePreservations,
          ],
          proposed: {
            candidateModules: [],
            exactPath: "deferred",
            scope: "package-wide",
          },
          provenance,
          rationale: {
            facts: [
              ...facts,
              `serves ${new Set(group.flatMap((f) => f.consumers.responsibilities)).size} responsibilities, at or above the package-wide threshold of ${primitives.policy.packageWide.threshold}`,
            ],
            sources: [source],
          },
          subject,
          uncertainties: publicUncertainty,
        }
      );
    }
    analyzeInternalRewiringEntries5Entries2(
      scope,
      group,
      first,
      declaringRegion,
      subject,
      provenanceOf,
      module,
      ensureBaseline,
      candidate,
      source,
      eligible,
      foreign,
      ineligible,
      currentOfGroup,
      noEffects,
      localityOf,
      noConvention,
      basePreservations,
      factsOfGroup,
      symbolUncertainties
    );
    analyzeInternalRewiringEntries5Entries(
      first,
      foreign,
      candidateModulesFor,
      group,
      scope,
      dominantRole,
      alignmentOf,
      simulateMove,
      module,
      localityOf,
      provenanceOf,
      declaringRegion,
      ensureBaseline,
      candidate,
      source,
      subject,
      eligible,
      ineligible,
      current,
      basePreservations,
      facts,
      symbolUncertainties
    );
  }
}

function analyzeInternalRewiringEntries5Entries4(
  first: ArchitecturalRoleFinding,
  candidateModulesFor: (
    group: ArchitecturalRoleFinding[],
    region: string | undefined,
    scope: ArchitecturalScopeClass
  ) => ProposedArrangement["candidateModules"],
  group: ArchitecturalRoleFinding[],
  target: string,
  dominantRole: (findings: ArchitecturalRoleFinding[]) => ArchitecturalRole,
  alignmentOf: (
    role: ArchitecturalRole,
    scope: ArchitecturalScopeClass,
    dimension: ConventionDimension,
    matching: string[]
  ) => { alignment: ConventionAlignment; ids: string[] },
  simulateMove: (
    group: ArchitecturalRoleFinding[],
    module: string,
    targetRegion: string | undefined,
    targetModule: string | undefined,
    before: LocalityRelation,
    after: LocalityRelation,
    conventions: InternalRewiringEffects["conventions"]
  ) => MoveSimulation,
  module: string,
  localityOf: (finding: ArchitecturalRoleFinding) => LocalityRelation,
  provenanceOf: (
    group: ArchitecturalRoleFinding[],
    modules: string[],
    edges: { source: string; target: string }[],
    regions: (string | undefined)[],
    conventionIds: string[]
  ) => ScenarioProvenance,
  declaringRegion: string | undefined,
  ensureBaseline: (provenance: ScenarioProvenance) => void,
  current: CurrentArrangement,
  subject: ScenarioSubject,
  basePreservations: RewiringPreservation[],
  isRoot: (module: string) => boolean,
  facts: string[],
  symbolUncertainties: (
    group: ArchitecturalRoleFinding[],
    module: string,
    closure: SymbolMovementClosure | undefined,
    movement: boolean,
    targetKnown: boolean
  ) => ScenarioUncertainty[],
  candidate: (
    source: CandidateSource,
    kind: InternalRewiringScenarioKind,
    subject: ScenarioSubject,
    eligibility: ScenarioEligibility,
    scenario?: InternalRewiringScenario
  ) => void,
  eligible: (reasons: string[]) => ScenarioEligibility,
  push: (scenario: InternalRewiringScenario) => void,
  preserveCurrent: (
    subject: ScenarioSubject,
    current: CurrentArrangement,
    group: ArchitecturalRoleFinding[],
    module: string | undefined,
    preservations: RewiringPreservation[],
    provenance: ScenarioProvenance
  ) => InternalRewiringScenario,
  primaryModules: InternalModuleNode[],
  publicUncertainty: ScenarioUncertainty[]
) {
  const { placed } = first.declaration;
  const kind: InternalRewiringScenarioKind = placed
    ? "demote-primitive"
    : "colocate-primitive";
  const source: CandidateSource = placed
    ? "declared-outside-served-responsibility"
    : "declared-in-unresolved-module";
  const targetModules = candidateModulesFor(
    group,
    target,
    "responsibility-local"
  );
  const targetModule =
    targetModules.length === 1 ? targetModules[0]?.module : undefined;
  const role = dominantRole(group);
  const directory = alignmentOf(role, "responsibility-local", "directory", [
    "inside-responsibility",
    "responsibility-root",
    "dedicated-role-directory",
  ]);
  const simulation = simulateMove(
    group,
    module,
    target,
    targetModule,
    localityOf(first),
    "declared-in-serving-responsibility",
    { alignment: directory.alignment, conventionIds: directory.ids }
  );
  const provenance = provenanceOf(
    group,
    [module],
    simulation.edges,
    [declaringRegion, target],
    directory.ids
  );
  ensureBaseline(provenance);
  const scenario: InternalRewiringScenario =
    analyzeInternalRewiringEntries5Entries3(
      simulation,
      current,
      kind,
      subject,
      target,
      basePreservations,
      isRoot,
      module,
      targetModules,
      provenance,
      facts,
      source,
      symbolUncertainties,
      group
    );
  candidate(
    source,
    kind,
    subject,
    eligible([
      `responsibility-local scope served by ${target}`,
      placed
        ? `declared in ${declaringRegion ?? ""}`
        : `declared in unresolved module ${module}`,
    ]),
    scenario
  );
  // The consumer edges that would follow.
  if (simulation.edges.length > 0) {
    const redirectSubject: ScenarioSubject = {
      edges: simulation.edges.map((e) => ({
        source: e.source,
        target: e.target,
      })),
      key: `${target}→${module}`,
      kind: "internal-dependency",
      module,
    };
    const redirectCurrent: CurrentArrangement = {
      module,
      moduleStatus: current.moduleStatus,
      ...(declaringRegion !== undefined && {
        responsibility: declaringRegion,
      }),
      dependency: {
        edges: simulation.edges.length,
        symbols: new Set(simulation.edges.flatMap((e) => e.symbolIds)).size,
      },
    };
    push(
      preserveCurrent(
        redirectSubject,
        redirectCurrent,
        group,
        module,
        ["symbol-identity", "module-identity"],
        provenance
      )
    );
    const redirect: InternalRewiringScenario = {
      current: redirectCurrent,
      effects: {
        ...simulation.effects,
        locality: {
          after: "not-applicable",
          before: "not-applicable",
          symbols: 0,
        },
        moduleComposition: {
          ...simulation.effects.moduleComposition,
          modules: same(primaryModules.length),
          roleGroups: same(
            simulation.effects.moduleComposition.roleGroups.before
          ),
          scopeGroups: same(
            simulation.effects.moduleComposition.scopeGroups.before
          ),
        },
      },
      id: scenarioId(
        "redirect-internal-dependency",
        subjectIds(redirectSubject),
        `responsibility-local:${target}`
      ),
      kind: "redirect-internal-dependency",
      preservations: ["symbol-identity"],
      proposed: {
        candidateModules: targetModules,
        exactPath: "deferred",
        redirect: simulation.edges,
        responsibility: target,
        scope: "responsibility-local",
      },
      provenance,
      rationale: {
        facts: [
          `follows ${scenario.id}`,
          `${simulation.edges.length} consumer edges carry the group; ${simulation.effects.dependencies.edgesRemoved} carry nothing else`,
        ],
        sources: [source],
      },
      subject: redirectSubject,
      uncertainties: publicUncertainty,
    };
    candidate(
      source,
      "redirect-internal-dependency",
      redirectSubject,
      eligible([`${simulation.edges.length} consumer edges`]),
      redirect
    );
  }
}

function analyzeInternalRewiringEntries5Entries3(
  simulation: MoveSimulation,
  current: CurrentArrangement,
  kind: InternalRewiringScenarioKind,
  subject: ScenarioSubject,
  target: string,
  basePreservations: RewiringPreservation[],
  isRoot: (module: string) => boolean,
  module: string,
  targetModules: { module: string; evidence: TargetEvidence[] }[],
  provenance: ScenarioProvenance,
  facts: string[],
  source: CandidateSource,
  symbolUncertainties: (
    group: ArchitecturalRoleFinding[],
    module: string,
    closure: SymbolMovementClosure | undefined,
    movement: boolean,
    targetKnown: boolean
  ) => ScenarioUncertainty[],
  group: ArchitecturalRoleFinding[]
): InternalRewiringScenario {
  return {
    closure: simulation.closure,
    current,
    effects: simulation.effects,
    id: scenarioId(
      kind,
      subject.symbolIds ?? [],
      `responsibility-local:${target}`
    ),
    kind,
    preservations: [
      ...basePreservations,
      ...(isRoot(module)
        ? (["composition-role"] as RewiringPreservation[])
        : []),
      ...(simulation.effects.cycles.outcome === "unchanged"
        ? (["cycle-atomicity"] as RewiringPreservation[])
        : []),
    ],
    proposed: {
      candidateModules: targetModules,
      exactPath: "deferred",
      responsibility: target,
      scope: "responsibility-local",
    },
    provenance,
    rationale: { facts, sources: [source] },
    subject,
    uncertainties: symbolUncertainties(
      group,
      module,
      simulation.closure,
      true,
      targetModules.length > 0
    ),
  };
}

function analyzeInternalRewiringEntries5Entries2(
  scope: "cross-responsibility" | "package-wide",
  group: ArchitecturalRoleFinding[],
  first: ArchitecturalRoleFinding,
  declaringRegion: string | undefined,
  subject: ScenarioSubject,
  provenanceOf: (
    group: ArchitecturalRoleFinding[],
    modules: string[],
    edges: { source: string; target: string }[],
    regions: (string | undefined)[],
    conventionIds: string[]
  ) => ScenarioProvenance,
  module: string,
  ensureBaseline: (provenance: ScenarioProvenance) => void,
  candidate: (
    source: CandidateSource,
    kind: InternalRewiringScenarioKind,
    subject: ScenarioSubject,
    eligibility: ScenarioEligibility,
    scenario?: InternalRewiringScenario
  ) => void,
  source: "cross-responsibility" | "package-wide",
  eligible: (reasons: string[]) => ScenarioEligibility,
  foreign: string[],
  ineligible: (reasons: string[], missing: string[]) => ScenarioEligibility,
  currentOfGroup: (
    group: ArchitecturalRoleFinding[],
    module: string
  ) => CurrentArrangement,
  noEffects: (
    module: string | undefined,
    symbols: number,
    relationLocality: LocalityRelation,
    conventions?: InternalRewiringEffects["conventions"]
  ) => InternalRewiringEffects,
  localityOf: (finding: ArchitecturalRoleFinding) => LocalityRelation,
  noConvention: {
    alignment: "no-applicable-convention";
    conventionIds: never[];
  },
  basePreservations: RewiringPreservation[],
  factsOfGroup: (group: ArchitecturalRoleFinding[]) => string[],
  symbolUncertainties: (
    group: ArchitecturalRoleFinding[],
    module: string,
    closure: SymbolMovementClosure | undefined,
    movement: boolean,
    targetKnown: boolean
  ) => ScenarioUncertainty[]
) {
  if (scope === "cross-responsibility") {
    const contracts = group.filter((f) =>
      CONTRACT_FAMILY.includes(f.primaryRole)
    );
    const dedicated = first.placement.module === "dedicated-role-module";
    const ownedByConsumer =
      declaringRegion !== undefined &&
      first.consumers.responsibilities.includes(declaringRegion);
    const preserveSubject: ScenarioSubject = {
      ...subject,
      symbolIds: contracts.map((f) => f.symbolId),
    };
    if (contracts.length > 0) {
      const holds = !first.declaration.placed || dedicated || ownedByConsumer;
      const provenance = provenanceOf(
        contracts,
        [module],
        [],
        [declaringRegion],
        []
      );
      if (holds) {
        ensureBaseline(provenance);
      }
      candidate(
        source,
        "preserve-cross-responsibility-contract",
        preserveSubject,
        resolveAnalyzeInternalRewiring(
          holds,
          eligible,
          contracts,
          foreign,
          ownedByConsumer,
          first,
          dedicated,
          ineligible
        ),
        resolveAnalyzeInternalRewiring2(
          holds,
          currentOfGroup,
          contracts,
          module,
          noEffects,
          localityOf,
          first,
          noConvention,
          preserveSubject,
          declaringRegion,
          basePreservations,
          provenance,
          factsOfGroup,
          source,
          symbolUncertainties
        )
      );
    }
  }
}

function analyzeInternalRewiringEntries5Entries(
  first: ArchitecturalRoleFinding,
  foreign: string[],
  candidateModulesFor: (
    group: ArchitecturalRoleFinding[],
    region: string | undefined,
    scope: ArchitecturalScopeClass
  ) => ProposedArrangement["candidateModules"],
  group: ArchitecturalRoleFinding[],
  scope: "cross-responsibility" | "package-wide",
  dominantRole: (findings: ArchitecturalRoleFinding[]) => ArchitecturalRole,
  alignmentOf: (
    role: ArchitecturalRole,
    scope: ArchitecturalScopeClass,
    dimension: ConventionDimension,
    matching: string[]
  ) => { alignment: ConventionAlignment; ids: string[] },
  simulateMove: (
    group: ArchitecturalRoleFinding[],
    module: string,
    targetRegion: string | undefined,
    targetModule: string | undefined,
    before: LocalityRelation,
    after: LocalityRelation,
    conventions: InternalRewiringEffects["conventions"]
  ) => MoveSimulation,
  module: string,
  localityOf: (finding: ArchitecturalRoleFinding) => LocalityRelation,
  provenanceOf: (
    group: ArchitecturalRoleFinding[],
    modules: string[],
    edges: { source: string; target: string }[],
    regions: (string | undefined)[],
    conventionIds: string[]
  ) => ScenarioProvenance,
  declaringRegion: string | undefined,
  ensureBaseline: (provenance: ScenarioProvenance) => void,
  candidate: (
    source: CandidateSource,
    kind: InternalRewiringScenarioKind,
    subject: ScenarioSubject,
    eligibility: ScenarioEligibility,
    scenario?: InternalRewiringScenario
  ) => void,
  source: "cross-responsibility" | "package-wide",
  subject: ScenarioSubject,
  eligible: (reasons: string[]) => ScenarioEligibility,
  ineligible: (reasons: string[], missing: string[]) => ScenarioEligibility,
  current: CurrentArrangement,
  basePreservations: RewiringPreservation[],
  facts: string[],
  symbolUncertainties: (
    group: ArchitecturalRoleFinding[],
    module: string,
    closure: SymbolMovementClosure | undefined,
    movement: boolean,
    targetKnown: boolean
  ) => ScenarioUncertainty[]
) {
  if (first.declaration.placed) {
    const promotable = foreign.length >= 2;
    const targetModules = candidateModulesFor(group, undefined, scope);
    const role = dominantRole(group);
    const directory = alignmentOf(role, scope, "directory", [
      "package-root",
      "dedicated-role-directory",
    ]);
    let simulation: MoveSimulation | undefined;
    if (promotable) {
      simulation = simulateMove(
        group,
        module,
        undefined,
        targetModules.length === 1 ? targetModules[0]?.module : undefined,
        localityOf(first),
        "declared-at-shared-scope",
        { alignment: directory.alignment, conventionIds: directory.ids }
      );
    } else {
      simulation = undefined;
    }
    const provenance = provenanceOf(
      group,
      [module],
      simulation?.edges ?? [],
      [declaringRegion, ...foreign],
      directory.ids
    );
    if (promotable) {
      ensureBaseline(provenance);
    }
    candidate(
      source,
      "promote-primitive",
      subject,
      promotable
        ? eligible([
            `${scope} scope declared inside ${declaringRegion ?? ""}`,
            `${foreign.length} other responsibilities consume the group`,
          ])
        : ineligible(
            [
              "one other responsibility consumes the group: an ordinary dependency",
            ],
            ["a second consuming responsibility"]
          ),
      resolveAnalyzeInternalRewiring3(
        simulation,
        current,
        subject,
        scope,
        basePreservations,
        group,
        targetModules,
        provenance,
        facts,
        source,
        symbolUncertainties,
        module
      )
    );
  }
}

function analyzeInternalRewiringEntries4(
  regionOf: (module: string) => string | undefined,
  node: InternalModuleNode,
  edgesBySource: Map<string, InternalModuleEdge[]>,
  usesBySourceTarget: Map<string, PackageLocalBindingUses>,
  local: PackageLocalReport,
  moduleEvidence: Map<string, ResponsibilityModuleEvidence>,
  policy: {
    compositionRoot: {
      minimumResponsibilities: number;
      maximumExportedSymbols: number;
      minimumWiringSites: number;
      minimumWiredResponsibilities: number;
    };
    orchestration: { maximumExportedSymbols: number };
    split: { minimumGroupSymbols: number };
    alignment: { minimumSupportRatio: number };
    closure: { largeShare: number };
    indirection: {
      maximumProviders: number;
      maximumExportedSymbols: number;
      maximumStatements: number;
    };
    surface: { minimumTargetModules: number; minimumSymbols: number };
    contract: { minimumSymbols: number };
    candidateModules: number;
    report: { topScenarios: number; topModules: number };
  },
  ambiguityOf: Map<string, ResponsibilityAmbiguityReason>,
  compositionByModule: Map<string, CompositionEvidence>
) {
  const own = regionOf(node.id);
  const targets = edgesBySource.get(node.id) ?? [];
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
    const region = regionOf(edge.target);
    if (region === undefined) {
      unresolvedTargets += 1;
    } else if (region !== own) {
      reached.add(region);
    }
    const uses = usesBySourceTarget.get(`${edge.source}→${edge.target}`);
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
    local.moduleRoles[node.id]?.kind === "aggregator" ||
    (moduleEvidence.get(node.id)?.roles ?? []).includes("aggregator");
  const evidence: string[] = [];
  const roles: CompositionRoleKind[] = [];
  const minimumWired = policy.compositionRoot.minimumWiredResponsibilities;
  const union = (keys: (keyof PackageLocalBindingUses)[]) =>
    new Set(keys.flatMap((key) => [...wiredBy[key]]));
  analyzeInternalRewiringEntries4Entries(
    isAggregator,
    roles,
    evidence,
    reached,
    union,
    minimumWired,
    wiring,
    wiredBy,
    node,
    policy
  );
  if (roles.length === 0) {
    roles.push(
      ambiguityOf.get(node.id) === "wide-dependent"
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
    reached.size >= policy.compositionRoot.minimumResponsibilities &&
    node.exportedSymbols <= policy.compositionRoot.maximumExportedSymbols &&
    wiringSites >= policy.compositionRoot.minimumWiringSites &&
    wiredResponsibilities.length >= minimumWired;
  if (compositionRoot) {
    evidence.push(
      `depends on ${reached.size} responsibilities, exports ${node.exportedSymbols}, ${wiringSites} wiring sites`
    );
  }
  const evidenceEntry = moduleEvidence.get(node.id);
  compositionByModule.set(node.id, {
    module: node.id,
    status: evidenceEntry?.status ?? "unresolved",
    ...(own !== undefined && { responsibility: own }),
    ...(ambiguityOf.has(node.id) && { ambiguity: ambiguityOf.get(node.id) }),
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

function analyzeInternalRewiringEntries4Entries(
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
    orchestration: { maximumExportedSymbols: number };
    split: { minimumGroupSymbols: number };
    alignment: { minimumSupportRatio: number };
    closure: { largeShare: number };
    indirection: {
      maximumProviders: number;
      maximumExportedSymbols: number;
      maximumStatements: number;
    };
    surface: { minimumTargetModules: number; minimumSymbols: number };
    contract: { minimumSymbols: number };
    candidateModules: number;
    report: { topScenarios: number; topModules: number };
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

function analyzeInternalRewiringEntries3(
  finding: PrimitiveModuleFinding,
  findingsByModule: Map<string, ArchitecturalRoleFinding[]>,
  regionOf: (module: string) => string | undefined,
  compositionByModule: Map<string, CompositionEvidence>,
  moduleNode: Map<string, InternalModuleNode>,
  preserveCurrent: (
    subject: ScenarioSubject,
    current: CurrentArrangement,
    group: ArchitecturalRoleFinding[],
    module: string | undefined,
    preservations: RewiringPreservation[],
    provenance: ScenarioProvenance
  ) => InternalRewiringScenario,
  isRoot: (module: string) => boolean,
  push: (scenario: InternalRewiringScenario) => void,
  provenanceOf: (
    group: ArchitecturalRoleFinding[],
    modules: string[],
    edges: { source: string; target: string }[],
    regions: (string | undefined)[],
    conventionIds: string[]
  ) => ScenarioProvenance,
  policy: {
    compositionRoot: {
      minimumResponsibilities: number;
      maximumExportedSymbols: number;
      minimumWiringSites: number;
      minimumWiredResponsibilities: number;
    };
    orchestration: { maximumExportedSymbols: number };
    split: { minimumGroupSymbols: number };
    alignment: { minimumSupportRatio: number };
    closure: { largeShare: number };
    indirection: {
      maximumProviders: number;
      maximumExportedSymbols: number;
      maximumStatements: number;
    };
    surface: { minimumTargetModules: number; minimumSymbols: number };
    contract: { minimumSymbols: number };
    candidateModules: number;
    report: { topScenarios: number; topModules: number };
  },
  findingById: Map<string, ArchitecturalRoleFinding>,
  candidateModulesFor: (
    group: ArchitecturalRoleFinding[],
    region: string | undefined,
    scope: ArchitecturalScopeClass
  ) => ProposedArrangement["candidateModules"],
  dominantRole: (findings: ArchitecturalRoleFinding[]) => ArchitecturalRole,
  alignmentOf: (
    role: ArchitecturalRole,
    scope: ArchitecturalScopeClass,
    dimension: ConventionDimension,
    matching: string[]
  ) => { alignment: ConventionAlignment; ids: string[] },
  simulateMove: (
    group: ArchitecturalRoleFinding[],
    module: string,
    targetRegion: string | undefined,
    targetModule: string | undefined,
    before: LocalityRelation,
    after: LocalityRelation,
    conventions: InternalRewiringEffects["conventions"]
  ) => MoveSimulation,
  localityOf: (finding: ArchitecturalRoleFinding) => LocalityRelation,
  closureOf: (group: string[], module: string) => SymbolMovementClosure,
  localDependencies: (
    symbolId: string
  ) => { symbolId: string; relationship: ClosureRelationship }[],
  edgeByKey: Map<string, InternalModuleEdge>,
  primaryModules: InternalModuleNode[],
  symbolUncertainties: (
    group: ArchitecturalRoleFinding[],
    module: string,
    closure: SymbolMovementClosure | undefined,
    movement: boolean,
    targetKnown: boolean
  ) => ScenarioUncertainty[],
  candidate: (
    source: CandidateSource,
    kind: InternalRewiringScenarioKind,
    subject: ScenarioSubject,
    eligibility: ScenarioEligibility,
    scenario?: InternalRewiringScenario
  ) => void,
  ineligible: (reasons: string[], missing: string[]) => ScenarioEligibility,
  eligible: (reasons: string[]) => ScenarioEligibility,
  conventionGroup: (
    role: ArchitecturalRole,
    scope: ArchitecturalScopeClass,
    dimension: ConventionDimension
  ) =>
    | {
        status: ConventionStatus;
        conventions: string[];
        values: { value: string; symbols: number }[];
      }
    | undefined,
  conventionById: Map<string, PlacementConvention>,
  roleSplitModules: Set<string>,
  noEffects: (
    module: string | undefined,
    symbols: number,
    relationLocality: LocalityRelation,
    conventions?: InternalRewiringEffects["conventions"]
  ) => InternalRewiringEffects,
  edgesByTarget: Map<string, InternalModuleEdge[]>,
  edgesBySource: Map<string, InternalModuleEdge[]>,
  moduleEvidence: Map<string, ResponsibilityModuleEvidence>,
  classifyEdge: (
    source: string,
    target: string
  ) => "within" | "cross" | "unresolved",
  reaches: (from: string, goal: (module: string) => boolean) => boolean,
  packagePublic: Set<string>
) {
  const { module } = finding;
  const all = findingsByModule.get(module) ?? [];
  const exported = all.filter((f) => f.exported);
  const subject: ScenarioSubject = { key: module, kind: "module", module };
  const region = regionOf(module);
  const groups = scopeGroups(exported);
  const roleList = roleGroups(
    exported.filter((f) => f.primaryRole !== "unknown")
  );
  const current: CurrentArrangement = {
    module,
    moduleStatus: finding.status,
    ...(region !== undefined && { responsibility: region }),
    roleGroups: roleList,
    roles: roleCounts(exported),
    scopeGroups: groups,
    ...(compositionByModule.has(module) && {
      compositionRoles: compositionByModule.get(module)?.roles ?? [],
    }),
  };
  const node = moduleNode.get(module);
  let baseline: InternalRewiringScenario | undefined;
  const ensureBaseline = (provenance: ScenarioProvenance) => {
    if (baseline !== undefined) {
      return;
    }
    baseline = preserveCurrent(
      subject,
      current,
      exported,
      module,
      [
        "module-identity",
        "symbol-identity",
        ...(region === undefined
          ? []
          : (["responsibility-ownership"] as RewiringPreservation[])),
        ...(isRoot(module)
          ? (["composition-role"] as RewiringPreservation[])
          : []),
      ],
      provenance
    );
    push(baseline);
  };
  const moduleProvenance = (
    group: ArchitecturalRoleFinding[],
    edges: { source: string; target: string }[],
    regions: (string | undefined)[],
    conventionIds: string[]
  ) =>
    provenanceOf(group, [module], edges, [region, ...regions], conventionIds);

  // Split by responsibility.
  const scoped = (g: ScopeGroup) =>
    g.scope === "responsibility-local" ||
    g.scope === "cross-responsibility" ||
    g.scope === "package-wide";
  if (finding.composition.scopes === "mixed-scope") {
    const localGroups = groups.filter(
      (g) => g.scope === "responsibility-local"
    );
    const qualifying = localGroups.filter(
      (g) => g.symbolIds.length >= policy.split.minimumGroupSymbols
    );
    const remainderOf = (separated: ScopeGroup[]) =>
      groups.filter((g) => !separated.includes(g));
    const splitScenario = (
      separated: ScopeGroup[],
      variant: "partial" | "full"
    ): InternalRewiringScenario =>
      splitScenarioEntries2(
        separated,
        findingById,
        remainderOf,
        candidateModulesFor,
        dominantRole,
        alignmentOf,
        simulateMove,
        module,
        localityOf,
        closureOf,
        localDependencies,
        node,
        edgeByKey,
        finding,
        primaryModules,
        exported,
        roleList,
        scoped,
        symbolUncertainties,
        variant,
        current,
        isRoot,
        moduleProvenance,
        localGroups,
        subject
      );
    if (qualifying.length === 0) {
      candidate(
        "mixed-scope",
        "split-module-by-responsibility",
        subject,
        ineligible(
          [
            `${localGroups.length} responsibility-local groups, largest ${localGroups[0]?.symbolIds.length ?? 0} symbols`,
          ],
          [
            `a responsibility-local group of ${policy.split.minimumGroupSymbols}+ symbols`,
          ]
        )
      );
    } else {
      const [strongest] = qualifying;
      if (strongest !== undefined) {
        const partial = splitScenario([strongest], "partial");
        ensureBaseline(partial.provenance);
        candidate(
          "mixed-scope",
          "split-module-by-responsibility",
          subject,
          eligible([
            `mixed-scope: ${groups.length} scope groups`,
            `${qualifying.length} responsibility-local groups at or above ${policy.split.minimumGroupSymbols} symbols`,
          ]),
          partial
        );
        if (qualifying.length > 1) {
          push(splitScenario(qualifying, "full"));
        }
      }
    }
  }

  // Split by role.
  analyzeInternalRewiringEntries3Entries3(
    finding,
    groups,
    roleList,
    policy,
    conventionGroup,
    conventionById,
    closureOf,
    module,
    localDependencies,
    findingById,
    moduleProvenance,
    ensureBaseline,
    symbolUncertainties,
    roleSplitModules,
    candidate,
    subject,
    eligible,
    current,
    noEffects,
    node,
    primaryModules,
    region,
    exported,
    ineligible
  );

  // Composition root.
  const composition = compositionByModule.get(module);
  analyzeInternalRewiringEntries3Entries(
    composition,
    exported,
    moduleProvenance,
    ensureBaseline,
    candidate,
    subject,
    eligible,
    current,
    noEffects,
    module,
    node,
    region,
    policy,
    ineligible
  );

  // Indirection.
  const thin =
    node?.fanIn === 1 && node.fanOut >= 1 && node.cycle === undefined;
  const consumerOfThin = (edgesByTarget.get(module) ?? [])[0]?.source ?? "";
  analyzeInternalRewiringEntries3Entries2(
    thin,
    composition,
    compositionByModule,
    consumerOfThin,
    edgesBySource,
    module,
    moduleEvidence,
    policy,
    node,
    all,
    candidate,
    subject,
    ineligible,
    classifyEdge,
    edgeByKey,
    moduleNode,
    reaches,
    provenanceOf,
    region,
    regionOf,
    ensureBaseline,
    eligible,
    current,
    primaryModules,
    roleList,
    groups,
    packagePublic
  );
}

function analyzeInternalRewiringEntries3Entries3(
  finding: PrimitiveModuleFinding,
  groups: ScopeGroup[],
  roleList: RoleGroup[],
  policy: {
    compositionRoot: {
      minimumResponsibilities: number;
      maximumExportedSymbols: number;
      minimumWiringSites: number;
      minimumWiredResponsibilities: number;
    };
    orchestration: { maximumExportedSymbols: number };
    split: { minimumGroupSymbols: number };
    alignment: { minimumSupportRatio: number };
    closure: { largeShare: number };
    indirection: {
      maximumProviders: number;
      maximumExportedSymbols: number;
      maximumStatements: number;
    };
    surface: { minimumTargetModules: number; minimumSymbols: number };
    contract: { minimumSymbols: number };
    candidateModules: number;
    report: { topScenarios: number; topModules: number };
  },
  conventionGroup: (
    role: ArchitecturalRole,
    scope: ArchitecturalScopeClass,
    dimension: ConventionDimension
  ) =>
    | {
        status: ConventionStatus;
        conventions: string[];
        values: { value: string; symbols: number }[];
      }
    | undefined,
  conventionById: Map<string, PlacementConvention>,
  closureOf: (group: string[], module: string) => SymbolMovementClosure,
  module: string,
  localDependencies: (
    symbolId: string
  ) => { symbolId: string; relationship: ClosureRelationship }[],
  findingById: Map<string, ArchitecturalRoleFinding>,
  moduleProvenance: (
    group: ArchitecturalRoleFinding[],
    edges: { source: string; target: string }[],
    regions: (string | undefined)[],
    conventionIds: string[]
  ) => ScenarioProvenance,
  ensureBaseline: (provenance: ScenarioProvenance) => void,
  symbolUncertainties: (
    group: ArchitecturalRoleFinding[],
    module: string,
    closure: SymbolMovementClosure | undefined,
    movement: boolean,
    targetKnown: boolean
  ) => ScenarioUncertainty[],
  roleSplitModules: Set<string>,
  candidate: (
    source: CandidateSource,
    kind: InternalRewiringScenarioKind,
    subject: ScenarioSubject,
    eligibility: ScenarioEligibility,
    scenario?: InternalRewiringScenario
  ) => void,
  subject: ScenarioSubject,
  eligible: (reasons: string[]) => ScenarioEligibility,
  current: CurrentArrangement,
  noEffects: (
    module: string | undefined,
    symbols: number,
    relationLocality: LocalityRelation,
    conventions?: InternalRewiringEffects["conventions"]
  ) => InternalRewiringEffects,
  node: InternalModuleNode | undefined,
  primaryModules: InternalModuleNode[],
  region: string | undefined,
  exported: ArchitecturalRoleFinding[],
  ineligible: (reasons: string[], missing: string[]) => ScenarioEligibility
) {
  if (
    finding.composition.roles === "mixed-role" &&
    finding.composition.scopes === "single-scope"
  ) {
    const scope = groups[0]?.scope ?? "unclear";
    const qualifying = roleList.filter(
      (g) => g.symbolIds.length >= policy.split.minimumGroupSymbols
    );
    const supporting = qualifying.filter((g) => {
      const convention = conventionGroup(g.role, scope, "module");
      return (
        convention !== undefined &&
        convention.status !== "insufficient-evidence" &&
        convention.conventions.some(
          (id) => conventionById.get(id)?.value === "dedicated-role-module"
        )
      );
    });
    const ids = sorted(
      supporting.flatMap(
        (g) => conventionGroup(g.role, scope, "module")?.conventions ?? []
      )
    );
    if (qualifying.length >= 2 && supporting.length > 0) {
      const closure = closureOf(
        qualifying.flatMap((g) => g.symbolIds),
        module
      );
      const crossGroup = qualifying.some((a) =>
        a.symbolIds.some((id) =>
          localDependencies(id).some((dep) =>
            qualifying.some(
              (b) => b !== a && b.symbolIds.includes(dep.symbolId)
            )
          )
        )
      );
      const moving = qualifying
        .flatMap((g) => g.symbolIds.map((id) => findingById.get(id)))
        .filter((f): f is ArchitecturalRoleFinding => f !== undefined);
      const provenance = moduleProvenance(
        moving,
        [],
        [groups[0]?.responsibility],
        ids
      );
      ensureBaseline(provenance);
      const uncertainties = symbolUncertainties(
        moving,
        module,
        closure,
        true,
        false
      ).filter((u) => u.reason !== "target-module-unresolved");
      if (crossGroup) {
        uncertainties.push({
          detail: "a role group depends on another role group",
          reason: "closure-crosses-groups",
        });
      }
      uncertainties.sort(
        (a, b) =>
          UNCERTAINTIES.indexOf(a.reason) - UNCERTAINTIES.indexOf(b.reason)
      );
      roleSplitModules.add(module);
      candidate(
        "mixed-role",
        "split-module-by-role",
        subject,
        eligible([
          `mixed-role at one scope (${scope})`,
          `${qualifying.length} role groups at or above ${policy.split.minimumGroupSymbols} symbols`,
          `dedicated-role-module convention observed for ${supporting.map((g) => g.role).join(", ")}`,
        ]),
        {
          closure,
          current,
          effects: {
            ...noEffects(module, moving.length, "not-applicable", {
              alignment: "matches-convention",
              conventionIds: ids,
            }),
            dependencies: {
              edgesAdded: 0,
              edgesRemoved: 0,
              edgesRetargeted: node?.fanIn ?? 0,
              modules: [
                {
                  fanIn: same(node?.fanIn ?? 0),
                  fanOut: same(node?.fanOut ?? 0),
                  module,
                },
              ],
            },
            moduleComposition: {
              module,
              modules: {
                after: primaryModules.length + qualifying.length - 1,
                before: primaryModules.length,
              },
              roleGroups: { after: 1, before: roleList.length },
              scopeGroups: same(groups.length),
            },
          },
          id: scenarioId(
            "split-module-by-role",
            [module],
            `roles:${qualifying.map((g) => g.role).join(",")}`
          ),
          kind: "split-module-by-role",
          preservations: [
            "symbol-identity",
            ...(region === undefined
              ? []
              : (["responsibility-ownership"] as RewiringPreservation[])),
          ],
          proposed: {
            scope: "dedicated-role-modules",
            ...(groups[0]?.responsibility !== undefined && {
              responsibility: groups[0].responsibility,
            }),
            candidateModules: [],
            exactPath: "deferred",
            separated: qualifying,
          },
          provenance,
          rationale: {
            facts: [
              `${roleList.length} roles among ${exported.length} exported symbols at one scope`,
              `role groups: ${qualifying.map((g) => `${g.symbolIds.length} ${g.role}`).join(", ")}`,
              `convention: ${ids.join(", ")}`,
            ],
            sources: ["mixed-role"],
          },
          subject,
          uncertainties,
        }
      );
    } else if (qualifying.length >= 2) {
      candidate(
        "mixed-role",
        "split-module-by-role",
        subject,
        ineligible(
          [
            `${qualifying.length} role groups, no dedicated-role-module convention at ${scope}`,
          ],
          ["an observed dedicated-role-module convention for one of the roles"]
        )
      );
    }
  }
}

function analyzeInternalRewiringEntries3Entries2(
  thin: boolean,
  composition: CompositionEvidence | undefined,
  compositionByModule: Map<string, CompositionEvidence>,
  consumerOfThin: string,
  edgesBySource: Map<string, InternalModuleEdge[]>,
  module: string,
  moduleEvidence: Map<string, ResponsibilityModuleEvidence>,
  policy: {
    compositionRoot: {
      minimumResponsibilities: number;
      maximumExportedSymbols: number;
      minimumWiringSites: number;
      minimumWiredResponsibilities: number;
    };
    orchestration: { maximumExportedSymbols: number };
    split: { minimumGroupSymbols: number };
    alignment: { minimumSupportRatio: number };
    closure: { largeShare: number };
    indirection: {
      maximumProviders: number;
      maximumExportedSymbols: number;
      maximumStatements: number;
    };
    surface: { minimumTargetModules: number; minimumSymbols: number };
    contract: { minimumSymbols: number };
    candidateModules: number;
    report: { topScenarios: number; topModules: number };
  },
  node: InternalModuleNode | undefined,
  all: ArchitecturalRoleFinding[],
  candidate: (
    source: CandidateSource,
    kind: InternalRewiringScenarioKind,
    subject: ScenarioSubject,
    eligibility: ScenarioEligibility,
    scenario?: InternalRewiringScenario
  ) => void,
  subject: ScenarioSubject,
  ineligible: (reasons: string[], missing: string[]) => ScenarioEligibility,
  classifyEdge: (
    source: string,
    target: string
  ) => "within" | "cross" | "unresolved",
  edgeByKey: Map<string, InternalModuleEdge>,
  moduleNode: Map<string, InternalModuleNode>,
  reaches: (from: string, goal: (module: string) => boolean) => boolean,
  provenanceOf: (
    group: ArchitecturalRoleFinding[],
    modules: string[],
    edges: { source: string; target: string }[],
    regions: (string | undefined)[],
    conventionIds: string[]
  ) => ScenarioProvenance,
  region: string | undefined,
  regionOf: (module: string) => string | undefined,
  ensureBaseline: (provenance: ScenarioProvenance) => void,
  eligible: (reasons: string[]) => ScenarioEligibility,
  current: CurrentArrangement,
  primaryModules: InternalModuleNode[],
  roleList: RoleGroup[],
  groups: ScopeGroup[],
  packagePublic: Set<string>
) {
  if (node === undefined) {
    return;
  }
  if (
    thin &&
    composition?.roles.includes("aggregation") !== true &&
    compositionByModule.get(consumerOfThin)?.roles.includes("aggregation") !==
      true
  ) {
    const consumer = consumerOfThin;
    const providers = sorted(
      (edgesBySource.get(module) ?? []).map((e) => e.target)
    );
    const evidence = moduleEvidence.get(module);
    const reasons: string[] = [];
    const missing: string[] = [];
    if (providers.length > policy.indirection.maximumProviders) {
      missing.push(
        `at most ${policy.indirection.maximumProviders} providers (has ${providers.length})`
      );
    }
    if (node.exportedSymbols > policy.indirection.maximumExportedSymbols) {
      missing.push(
        `at most ${policy.indirection.maximumExportedSymbols} exported symbols (has ${node.exportedSymbols})`
      );
    }
    if ((evidence?.behaviorMass ?? 0) > policy.indirection.maximumStatements) {
      missing.push(
        `at most ${policy.indirection.maximumStatements} statements (has ${evidence?.behaviorMass ?? 0})`
      );
    }
    if ((evidence?.concepts.declared ?? 0) > 0) {
      missing.push(
        `no declared concept (declares ${evidence?.concepts.declared ?? 0})`
      );
    }
    const structural = all.filter((f) =>
      f.roles.some((r) => STRUCTURAL_ROLES.includes(r))
    );
    if (structural.length > 0) {
      missing.push(
        `no contract, adapter, or implementation role (${structural.map((f) => `${f.name}: ${f.primaryRole}`).join(", ")})`
      );
    }
    reasons.push(
      `one consumer (${consumer}), ${providers.length} providers, ${node.exportedSymbols} exports`
    );
    analyzeInternalRewiringEntries3Entries2Entries(
      missing,
      node,
      policy,
      candidate,
      subject,
      ineligible,
      reasons,
      classifyEdge,
      consumer,
      module,
      edgeByKey,
      providers,
      moduleNode,
      reaches,
      provenanceOf,
      all,
      region,
      regionOf,
      ensureBaseline,
      eligible,
      current,
      primaryModules,
      roleList,
      groups,
      evidence,
      packagePublic
    );
  }
}

function analyzeInternalRewiringEntries3Entries2Entries(
  missing: string[],
  node: InternalModuleNode,
  policy: {
    compositionRoot: {
      minimumResponsibilities: number;
      maximumExportedSymbols: number;
      minimumWiringSites: number;
      minimumWiredResponsibilities: number;
    };
    orchestration: { maximumExportedSymbols: number };
    split: { minimumGroupSymbols: number };
    alignment: { minimumSupportRatio: number };
    closure: { largeShare: number };
    indirection: {
      maximumProviders: number;
      maximumExportedSymbols: number;
      maximumStatements: number;
    };
    surface: { minimumTargetModules: number; minimumSymbols: number };
    contract: { minimumSymbols: number };
    candidateModules: number;
    report: { topScenarios: number; topModules: number };
  },
  candidate: (
    source: CandidateSource,
    kind: InternalRewiringScenarioKind,
    subject: ScenarioSubject,
    eligibility: ScenarioEligibility,
    scenario?: InternalRewiringScenario
  ) => void,
  subject: ScenarioSubject,
  ineligible: (reasons: string[], missing: string[]) => ScenarioEligibility,
  reasons: string[],
  classifyEdge: (
    source: string,
    target: string
  ) => "within" | "cross" | "unresolved",
  consumer: string,
  module: string,
  edgeByKey: Map<string, InternalModuleEdge>,
  providers: string[],
  moduleNode: Map<string, InternalModuleNode>,
  reaches: (from: string, goal: (module: string) => boolean) => boolean,
  provenanceOf: (
    group: ArchitecturalRoleFinding[],
    modules: string[],
    edges: { source: string; target: string }[],
    regions: (string | undefined)[],
    conventionIds: string[]
  ) => ScenarioProvenance,
  all: ArchitecturalRoleFinding[],
  region: string | undefined,
  regionOf: (module: string) => string | undefined,
  ensureBaseline: (provenance: ScenarioProvenance) => void,
  eligible: (reasons: string[]) => ScenarioEligibility,
  current: CurrentArrangement,
  primaryModules: InternalModuleNode[],
  roleList: RoleGroup[],
  groups: ScopeGroup[],
  evidence: ResponsibilityModuleEvidence | undefined,
  packagePublic: Set<string>
) {
  if (
    missing.length > 0 &&
    node.exportedSymbols <= policy.indirection.maximumExportedSymbols
  ) {
    candidate(
      "indirection",
      "collapse-indirection",
      subject,
      ineligible(reasons, missing)
    );
  } else if (missing.length === 0) {
    const before = {
      cross: 0,
      unresolved: 0,
      within: 0,
    };
    const after = { cross: 0, unresolved: 0, within: 0 };
    before[classifyEdge(consumer, module)] += 1;
    const visitProvider = (provider: string) => {
      before[classifyEdge(module, provider)] += 1;
      if (edgeByKey.has(`${consumer}→${provider}`)) {
        return;
      }
      after[classifyEdge(consumer, provider)] += 1;
    };
    for (const provider of providers) {
      visitProvider(provider);
    }
    const added = providers.filter(
      (p) => !edgeByKey.has(`${consumer}→${p}`)
    ).length;
    const consumerNode = moduleNode.get(consumer);
    const potential = providers.some((p) => reaches(p, (m) => m === consumer));
    const provenance = provenanceOf(
      all,
      [module, consumer, ...providers],
      [
        { source: consumer, target: module },
        ...providers.map((p) => ({ source: module, target: p })),
      ],
      [region, regionOf(consumer), ...providers.map(regionOf)],
      []
    );
    ensureBaseline(provenance);
    candidate(
      "indirection",
      "collapse-indirection",
      subject,
      eligible(reasons),
      {
        current: {
          ...current,
          dependency: {
            edges: 1 + providers.length,
            symbols: node.providedSymbols,
          },
        },
        effects: {
          conventions: {
            alignment: "no-applicable-convention",
            conventionIds: [],
          },
          cycles: {
            membership: [],
            outcome: potential ? "potential-new-cycle" : "none",
            ...(potential && {
              detail: `a provider already reaches ${consumer}`,
            }),
          },
          dependencies: {
            edgesAdded: added,
            edgesRemoved: 1 + providers.length,
            edgesRetargeted: 0,
            modules: [
              {
                fanIn: { after: 0, before: 1 },
                fanOut: { after: 0, before: node.fanOut },
                module,
              },
              {
                fanIn: same(consumerNode?.fanIn ?? 0),
                fanOut: {
                  after: (consumerNode?.fanOut ?? 0) - 1 + added,
                  before: consumerNode?.fanOut ?? 0,
                },
                module: consumer,
              },
            ],
          },
          locality: {
            after: "not-applicable",
            before: "not-applicable",
            symbols: all.length,
          },
          moduleComposition: {
            module,
            modules: {
              after: primaryModules.length - 1,
              before: primaryModules.length,
            },
            roleGroups: { after: 0, before: roleList.length },
            scopeGroups: { after: 0, before: groups.length },
          },
          responsibilityBoundaries: {
            crossEdges: { after: after.cross, before: before.cross },
            crossingSymbols: same(0),
            responsibilitiesTouched: sorted(
              [region, regionOf(consumer), ...providers.map(regionOf)].filter(
                (r): r is string => r !== undefined
              )
            ),
            unresolvedEdges: {
              after: after.unresolved,
              before: before.unresolved,
            },
            withinEdges: { after: after.within, before: before.within },
          },
        },
        id: scenarioId("collapse-indirection", [module], `direct:${consumer}`),
        kind: "collapse-indirection",
        preservations: ["symbol-identity"],
        proposed: {
          scope: "direct-dependency",
          ...(regionOf(consumer) !== undefined && {
            responsibility: regionOf(consumer),
          }),
          candidateModules:
            region !== undefined && regionOf(consumer) === region
              ? [{ evidence: ["same-responsibility"], module: consumer }]
              : [],
          collapse: { consumer, intermediary: module, providers },
          exactPath: "deferred",
        },
        provenance,
        rationale: {
          facts: [
            ...reasons,
            `${evidence?.behaviorMass ?? 0} statements, ${evidence?.concepts.declared ?? 0} declared concepts`,
          ],
          sources: ["indirection"],
        },
        subject,
        uncertainties: [
          ...(all.some((f) => packagePublic.has(f.symbolId))
            ? [
                {
                  detail: "the intermediary exports a package-public symbol",
                  reason: "package-public-external-impact" as const,
                },
              ]
            : []),
          {
            detail:
              "the intermediary's own declarations fold into the consumer or a provider; function-body references are not measured",
            reason: "movement-closure-incomplete" as const,
          },
        ],
      }
    );
  }
}

function analyzeInternalRewiringEntries3Entries(
  composition: CompositionEvidence | undefined,
  exported: ArchitecturalRoleFinding[],
  moduleProvenance: (
    group: ArchitecturalRoleFinding[],
    edges: { source: string; target: string }[],
    regions: (string | undefined)[],
    conventionIds: string[]
  ) => ScenarioProvenance,
  ensureBaseline: (provenance: ScenarioProvenance) => void,
  candidate: (
    source: CandidateSource,
    kind: InternalRewiringScenarioKind,
    subject: ScenarioSubject,
    eligibility: ScenarioEligibility,
    scenario?: InternalRewiringScenario
  ) => void,
  subject: ScenarioSubject,
  eligible: (reasons: string[]) => ScenarioEligibility,
  current: CurrentArrangement,
  noEffects: (
    module: string | undefined,
    symbols: number,
    relationLocality: LocalityRelation,
    conventions?: InternalRewiringEffects["conventions"]
  ) => InternalRewiringEffects,
  module: string,
  node: InternalModuleNode | undefined,
  region: string | undefined,
  policy: {
    compositionRoot: {
      minimumResponsibilities: number;
      maximumExportedSymbols: number;
      minimumWiringSites: number;
      minimumWiredResponsibilities: number;
    };
    orchestration: { maximumExportedSymbols: number };
    split: { minimumGroupSymbols: number };
    alignment: { minimumSupportRatio: number };
    closure: { largeShare: number };
    indirection: {
      maximumProviders: number;
      maximumExportedSymbols: number;
      maximumStatements: number;
    };
    surface: { minimumTargetModules: number; minimumSymbols: number };
    contract: { minimumSymbols: number };
    candidateModules: number;
    report: { topScenarios: number; topModules: number };
  },
  ineligible: (reasons: string[], missing: string[]) => ScenarioEligibility
) {
  if (composition !== undefined) {
    analyzeInternalRewiringEntries3EntriesEntries(
      composition,
      exported,
      moduleProvenance,
      ensureBaseline,
      candidate,
      subject,
      eligible,
      current,
      noEffects,
      module,
      node,
      region,
      policy,
      ineligible
    );
  }
}

function analyzeInternalRewiringEntries3EntriesEntries(
  composition: CompositionEvidence,
  exported: ArchitecturalRoleFinding[],
  moduleProvenance: (
    group: ArchitecturalRoleFinding[],
    edges: { source: string; target: string }[],
    regions: (string | undefined)[],
    conventionIds: string[]
  ) => ScenarioProvenance,
  ensureBaseline: (provenance: ScenarioProvenance) => void,
  candidate: (
    source: CandidateSource,
    kind: InternalRewiringScenarioKind,
    subject: ScenarioSubject,
    eligibility: ScenarioEligibility,
    scenario?: InternalRewiringScenario
  ) => void,
  subject: ScenarioSubject,
  eligible: (reasons: string[]) => ScenarioEligibility,
  current: CurrentArrangement,
  noEffects: (
    module: string | undefined,
    symbols: number,
    relationLocality: LocalityRelation,
    conventions?: InternalRewiringEffects["conventions"]
  ) => InternalRewiringEffects,
  module: string,
  node: InternalModuleNode | undefined,
  region: string | undefined,
  policy: {
    compositionRoot: {
      minimumResponsibilities: number;
      maximumExportedSymbols: number;
      minimumWiringSites: number;
      minimumWiredResponsibilities: number;
    };
    orchestration: { maximumExportedSymbols: number };
    split: { minimumGroupSymbols: number };
    alignment: { minimumSupportRatio: number };
    closure: { largeShare: number };
    indirection: {
      maximumProviders: number;
      maximumExportedSymbols: number;
      maximumStatements: number;
    };
    surface: { minimumTargetModules: number; minimumSymbols: number };
    contract: { minimumSymbols: number };
    candidateModules: number;
    report: { topScenarios: number; topModules: number };
  },
  ineligible: (reasons: string[], missing: string[]) => ScenarioEligibility
) {
  if (composition.compositionRoot) {
    const localOnes = exported.filter(
      (f) =>
        f.scope === "responsibility-local" &&
        f.served?.declarationAgrees === false
    );
    const provenance = moduleProvenance(
      exported,
      [],
      composition.responsibilities,
      []
    );
    ensureBaseline(provenance);
    candidate(
      "composition-root",
      "preserve-composition-root",
      subject,
      eligible(composition.evidence),
      {
        current,
        effects: noEffects(module, exported.length, "not-applicable"),
        id: scenarioId(
          "preserve-composition-root",
          [module],
          "composition-root"
        ),
        kind: "preserve-composition-root",
        preservations: [
          "module-identity",
          "composition-role",
          "symbol-identity",
          ...(node?.cycle === undefined
            ? []
            : (["cycle-atomicity"] as RewiringPreservation[])),
        ],
        proposed: {
          scope: "unchanged",
          ...(region !== undefined && { responsibility: region }),
          candidateModules: [],
          exactPath: "deferred",
        },
        provenance,
        rationale: {
          facts: [
            ...composition.evidence,
            `roles: ${composition.roles.join(", ")}`,
            localOnes.length > 0
              ? `${localOnes.length} responsibility-local declarations served elsewhere have their own scenarios`
              : "no responsibility-local declarations served elsewhere",
          ],
          sources: ["composition-root"],
        },
        subject,
        uncertainties: [],
      }
    );
  } else if (composition.ambiguity === "wide-dependent") {
    const sites =
      composition.wiring.constructed +
      composition.wiring.called +
      composition.wiring.argument +
      composition.wiring.collected +
      composition.wiring.rendered;
    const missing: string[] = [];
    if (!composition.roles.some((role) => WIRING_ROLES.includes(role))) {
      missing.push(
        "construction, registration, orchestration, or provision across responsibilities"
      );
    }
    if (
      composition.responsibilities.length <
      policy.compositionRoot.minimumResponsibilities
    ) {
      missing.push(
        `${policy.compositionRoot.minimumResponsibilities}+ responsibilities depended on`
      );
    }
    if (
      composition.exportedSymbols >
      policy.compositionRoot.maximumExportedSymbols
    ) {
      missing.push(
        `at most ${policy.compositionRoot.maximumExportedSymbols} exported symbols (has ${composition.exportedSymbols})`
      );
    }
    if (sites < policy.compositionRoot.minimumWiringSites) {
      missing.push(
        `${policy.compositionRoot.minimumWiringSites}+ wiring sites`
      );
    }
    if (
      composition.wiredResponsibilities.length <
      policy.compositionRoot.minimumWiredResponsibilities
    ) {
      missing.push(
        `wiring into ${policy.compositionRoot.minimumWiredResponsibilities}+ responsibilities`
      );
    }
    candidate(
      "wide-dependent",
      "preserve-composition-root",
      subject,
      ineligible(
        [
          `wide-dependent: ${composition.responsibilities.length} responsibilities, ${composition.exportedSymbols} exports, ${sites} wiring sites, roles ${composition.roles.join(", ")}`,
        ],
        missing
      )
    );
  }
}

function analyzeInternalRewiringEntries2(
  byModule: Map<string, ArchitecturalRoleFinding[]>,
  convention: PlacementConvention,
  scope: ArchitecturalScopeClass,
  regionOf: (module: string) => string | undefined,
  candidateModulesFor: (
    group: ArchitecturalRoleFinding[],
    region: string | undefined,
    scope: ArchitecturalScopeClass
  ) => ProposedArrangement["candidateModules"],
  currentOfGroup: (
    group: ArchitecturalRoleFinding[],
    module: string
  ) => CurrentArrangement,
  provenanceOf: (
    group: ArchitecturalRoleFinding[],
    modules: string[],
    edges: { source: string; target: string }[],
    regions: (string | undefined)[],
    conventionIds: string[]
  ) => ScenarioProvenance,
  strong: boolean,
  candidate: (
    source: CandidateSource,
    kind: InternalRewiringScenarioKind,
    subject: ScenarioSubject,
    eligibility: ScenarioEligibility,
    scenario?: InternalRewiringScenario
  ) => void,
  ineligible: (reasons: string[], missing: string[]) => ScenarioEligibility,
  policy: {
    compositionRoot: {
      minimumResponsibilities: number;
      maximumExportedSymbols: number;
      minimumWiringSites: number;
      minimumWiredResponsibilities: number;
    };
    orchestration: { maximumExportedSymbols: number };
    split: { minimumGroupSymbols: number };
    alignment: { minimumSupportRatio: number };
    closure: { largeShare: number };
    indirection: {
      maximumProviders: number;
      maximumExportedSymbols: number;
      maximumStatements: number;
    };
    surface: { minimumTargetModules: number; minimumSymbols: number };
    contract: { minimumSymbols: number };
    candidateModules: number;
    report: { topScenarios: number; topModules: number };
  },
  roleSplitModules: Set<string>,
  consumersOf: Map<string, InternalSymbolConsumer[]>,
  findingsByModule: Map<string, ArchitecturalRoleFinding[]>,
  closureOf: (group: string[], module: string) => SymbolMovementClosure,
  noEffects: (
    module: string | undefined,
    symbols: number,
    relationLocality: LocalityRelation,
    conventions?: InternalRewiringEffects["conventions"]
  ) => InternalRewiringEffects,
  localityOf: (finding: ArchitecturalRoleFinding) => LocalityRelation,
  push: (scenario: InternalRewiringScenario) => void,
  preserveCurrent: (
    subject: ScenarioSubject,
    current: CurrentArrangement,
    group: ArchitecturalRoleFinding[],
    module: string | undefined,
    preservations: RewiringPreservation[],
    provenance: ScenarioProvenance
  ) => InternalRewiringScenario,
  eligible: (reasons: string[]) => ScenarioEligibility,
  primaryModules: InternalModuleNode[],
  packagePublic: Set<string>,
  factsOfGroup: (group: ArchitecturalRoleFinding[]) => string[],
  symbolUncertainties: (
    group: ArchitecturalRoleFinding[],
    module: string,
    closure: SymbolMovementClosure | undefined,
    movement: boolean,
    targetKnown: boolean
  ) => ScenarioUncertainty[]
) {
  for (const [module, members] of [...byModule.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const [first] = members;
    if (first === undefined) {
      continue;
    }
    const subject: ScenarioSubject = {
      key: `${module}|align:${convention.role}/${scope}`,
      kind: "symbol-group",
      module,
      symbolIds: sorted(members.map((f) => f.symbolId)),
    };
    const declaringRegion = regionOf(module);
    const targetRegion =
      scope === "responsibility-local"
        ? first.served?.responsibility
        : undefined;
    const targets = candidateModulesFor(members, targetRegion, scope);
    const current = currentOfGroup(members, module);
    const provenance = provenanceOf(
      members,
      [module],
      [],
      [declaringRegion, targetRegion],
      [convention.id]
    );
    const reasons = [
      `${convention.id}: ${convention.support.symbols} symbols support, ${convention.exceptions.symbols} exceptions`,
    ];
    if (!strong) {
      candidate(
        "convention-outlier",
        "align-with-convention",
        subject,
        ineligible(reasons, [
          `support at least ${policy.alignment.minimumSupportRatio}× exceptions`,
        ])
      );
      continue;
    }
    if (roleSplitModules.has(module)) {
      candidate(
        "convention-outlier",
        "align-with-convention",
        subject,
        ineligible(reasons, [
          "a module not already covered by a split-by-role scenario",
        ])
      );
      continue;
    }
    const carrying = new Set(
      members.flatMap((f) =>
        (consumersOf.get(f.symbolId) ?? []).map(
          (c) => `${c.module}→${c.via ?? module}`
        )
      )
    );
    const exported = (findingsByModule.get(module) ?? []).filter(
      (f) => f.exported && f.primaryRole !== "unknown"
    );
    const ids = new Set(members.map((f) => f.symbolId));
    const rolesBefore = new Set(exported.map((f) => f.primaryRole)).size;
    const rolesAfter = new Set(
      exported.filter((f) => !ids.has(f.symbolId)).map((f) => f.primaryRole)
    ).size;
    const closure = closureOf([...ids], module);
    const base = noEffects(module, members.length, localityOf(first), {
      alignment: "matches-convention",
      conventionIds: [convention.id],
    });
    push(
      preserveCurrent(
        subject,
        current,
        members,
        module,
        [
          "module-identity",
          "symbol-identity",
          ...(declaringRegion === undefined
            ? []
            : (["responsibility-ownership"] as RewiringPreservation[])),
        ],
        provenance
      )
    );
    candidate(
      "convention-outlier",
      "align-with-convention",
      subject,
      eligible([...reasons, `placed in a mixed-role module: ${module}`]),
      {
        closure,
        current,
        effects: {
          ...base,
          dependencies: {
            ...base.dependencies,
            edgesRetargeted: carrying.size,
          },
          moduleComposition: {
            ...base.moduleComposition,
            modules: {
              after: primaryModules.length + (targets.length === 0 ? 1 : 0),
              before: primaryModules.length,
            },
            roleGroups: { after: rolesAfter, before: rolesBefore },
          },
        },
        id: scenarioId(
          "align-with-convention",
          subject.symbolIds ?? [],
          convention.id
        ),
        kind: "align-with-convention",
        preservations: [
          "symbol-identity",
          ...(declaringRegion === undefined
            ? []
            : (["responsibility-ownership"] as RewiringPreservation[])),
          ...(members.some((f) => packagePublic.has(f.symbolId))
            ? (["public-exposure"] as RewiringPreservation[])
            : []),
        ],
        proposed: {
          scope: "dedicated-role-modules",
          ...(targetRegion !== undefined && { responsibility: targetRegion }),
          candidateModules: targets,
          exactPath: "deferred",
        },
        provenance,
        rationale: {
          facts: [
            ...factsOfGroup(members),
            `${convention.support.symbols} comparable symbols sit in dedicated ${convention.role} modules; these ${members.length} sit beside other roles`,
          ],
          sources: ["convention-outlier"],
        },
        subject,
        uncertainties: symbolUncertainties(
          members,
          module,
          closure,
          true,
          targets.length > 0
        ),
      }
    );
  }
}

function analyzeInternalRewiringEntries(
  relationship: ResponsibilityRelationship,
  crossingSymbolsOf: (relationship: ResponsibilityRelationship) => string[],
  findingById: Map<string, ArchitecturalRoleFinding>,
  edgeByKey: Map<string, InternalModuleEdge>,
  moduleFinding: Map<string, PrimitiveModuleFinding>,
  regionById: Map<string, ResponsibilityRegion>,
  policy: {
    compositionRoot: {
      minimumResponsibilities: number;
      maximumExportedSymbols: number;
      minimumWiringSites: number;
      minimumWiredResponsibilities: number;
    };
    orchestration: { maximumExportedSymbols: number };
    split: { minimumGroupSymbols: number };
    alignment: { minimumSupportRatio: number };
    closure: { largeShare: number };
    indirection: {
      maximumProviders: number;
      maximumExportedSymbols: number;
      maximumStatements: number;
    };
    surface: { minimumTargetModules: number; minimumSymbols: number };
    contract: { minimumSymbols: number };
    candidateModules: number;
    report: { topScenarios: number; topModules: number };
  },
  preserveCurrent: (
    subject: ScenarioSubject,
    current: CurrentArrangement,
    group: ArchitecturalRoleFinding[],
    module: string | undefined,
    preservations: RewiringPreservation[],
    provenance: ScenarioProvenance
  ) => InternalRewiringScenario,
  push: (scenario: InternalRewiringScenario) => void,
  provenanceOf: (
    group: ArchitecturalRoleFinding[],
    modules: string[],
    edges: { source: string; target: string }[],
    regions: (string | undefined)[],
    conventionIds: string[]
  ) => ScenarioProvenance,
  candidate: (
    source: CandidateSource,
    kind: InternalRewiringScenarioKind,
    subject: ScenarioSubject,
    eligibility: ScenarioEligibility,
    scenario?: InternalRewiringScenario
  ) => void,
  eligible: (reasons: string[]) => ScenarioEligibility,
  responsibilities: InternalResponsibilityReport,
  primaryModules: InternalModuleNode[],
  ineligible: (reasons: string[], missing: string[]) => ScenarioEligibility,
  dominantRole: (findings: ArchitecturalRoleFinding[]) => ArchitecturalRole,
  alignmentOf: (
    role: ArchitecturalRole,
    scope: ArchitecturalScopeClass,
    dimension: ConventionDimension,
    matching: string[]
  ) => { alignment: ConventionAlignment; ids: string[] },
  packagePublic: Set<string>
) {
  const subject: ScenarioSubject = {
    key: `${relationship.from}→${relationship.to}`,
    kind: "responsibility-relationship",
    relationship: { from: relationship.from, to: relationship.to },
  };
  const crossing = crossingSymbolsOf(relationship)
    .map((id) => findingById.get(id))
    .filter((f): f is ArchitecturalRoleFinding => f !== undefined);
  const current: CurrentArrangement = {
    consumerResponsibilities: [relationship.from],
    relationship: {
      moduleEdges: relationship.moduleEdges,
      sourceModules: relationship.sourceModules.length,
      symbolFlow: relationship.symbolFlow,
      targetModules: relationship.targetModules.length,
    },
    responsibility: relationship.to,
    roles: roleCounts(crossing),
  };
  const edges = relationship.sourceModules.flatMap((source) =>
    relationship.targetModules
      .filter((target) => edgeByKey.has(`${source}→${target}`))
      .map((target) => ({ source, target }))
  );
  const targetCandidates = (): ProposedArrangement["candidateModules"] => {
    const found: ProposedArrangement["candidateModules"] = [];
    const visitModule = (module: string) => {
      const finding = moduleFinding.get(module);
      if (finding === undefined) {
        return;
      }
      const evidence: TargetEvidence[] = [];
      if (finding.shapes.includes("aggregator")) {
        evidence.push("existing-hub");
      }
      if (
        finding.composition.roles === "single-role" &&
        finding.composition.dominantRole !== undefined &&
        CONTRACT_FAMILY.includes(finding.composition.dominantRole.role)
      ) {
        evidence.push("dedicated-role-module");
      }
      if (evidence.length > 0) {
        found.push({ evidence, module });
      }
    };
    for (const module of regionById.get(relationship.to)?.modules ?? []) {
      visitModule(module);
    }
    return found
      .sort(
        (a, b) =>
          b.evidence.length - a.evidence.length ||
          a.module.localeCompare(b.module)
      )
      .slice(0, policy.candidateModules);
  };
  let baseline: InternalRewiringScenario | undefined;
  const ensureBaseline = (scenarioProvenance: ScenarioProvenance) => {
    if (baseline !== undefined) {
      return;
    }
    baseline = preserveCurrent(
      subject,
      current,
      crossing,
      undefined,
      ["symbol-identity", "responsibility-ownership"],
      scenarioProvenance
    );
    push(baseline);
  };
  const provenance = provenanceOf(
    crossing,
    sorted([...relationship.sourceModules, ...relationship.targetModules]),
    edges,
    [relationship.from, relationship.to, subject.key],
    []
  );

  // Surface.
  analyzeInternalRewiringEntriesEntries(
    relationship,
    policy,
    targetCandidates,
    ensureBaseline,
    provenance,
    candidate,
    subject,
    eligible,
    current,
    responsibilities,
    crossing,
    primaryModules,
    ineligible
  );

  // Contract beside implementation.
  const beside = crossing.filter(
    (f) =>
      CONTRACT_FAMILY.includes(f.primaryRole) &&
      f.placement.colocation === "with-behavior" &&
      f.declaration.responsibility === relationship.to
  );
  if (beside.length > 0) {
    const enough = beside.length >= policy.contract.minimumSymbols;
    const candidatesFound = targetCandidates().filter((c) =>
      c.evidence.includes("dedicated-role-module")
    );
    const contractSubject: ScenarioSubject = {
      ...subject,
      key: `${subject.key}|contract`,
    };
    if (enough) {
      const contractProvenance = provenanceOf(
        beside,
        sorted(beside.map((f) => f.declaration.module)),
        edges.filter((e) =>
          beside.some((f) => f.declaration.module === e.target)
        ),
        [relationship.from, relationship.to, subject.key],
        []
      );
      push(
        preserveCurrent(
          contractSubject,
          { ...current, roles: roleCounts(beside) },
          beside,
          undefined,
          [
            "symbol-identity",
            "responsibility-ownership",
            "cross-responsibility-contract",
          ],
          contractProvenance
        )
      );
      const carrying = edges.filter((e) =>
        (edgeByKey.get(`${e.source}→${e.target}`)?.symbols ?? []).some(
          (s) =>
            s.symbolId !== undefined &&
            beside.some((f) => f.symbolId === s.symbolId)
        )
      );
      candidate(
        "contract-beside-implementation",
        "formalize-cross-responsibility-contract",
        contractSubject,
        eligible([
          `${beside.length} contract-family symbols of ${relationship.to} consumed by ${relationship.from}`,
          `declared in ${new Set(beside.map((f) => f.declaration.module)).size} modules that also export behavior`,
        ]),
        {
          current: { ...current, roles: roleCounts(beside) },
          effects: {
            conventions: (() => {
              const role = dominantRole(beside);
              const alignment = alignmentOf(
                role,
                "cross-responsibility",
                "module",
                ["dedicated-role-module"]
              );
              return {
                alignment: alignment.alignment,
                conventionIds: alignment.ids,
              };
            })(),
            cycles: { membership: [], outcome: "none" },
            dependencies: {
              deepImports: {
                after: 1,
                before: new Set(carrying.map((e) => e.target)).size,
              },
              edgesAdded: 0,
              edgesRemoved: 0,
              edgesRetargeted: carrying.length,
              modules: [],
            },
            locality: {
              after: "declared-in-one-serving-responsibility",
              before: "declared-in-one-serving-responsibility",
              symbols: beside.length,
            },
            moduleComposition: {
              module: "",
              modules: {
                after:
                  primaryModules.length +
                  (candidatesFound.length === 0 ? 1 : 0),
                before: primaryModules.length,
              },
              roleGroups: same(0),
              scopeGroups: same(0),
            },
            responsibilityBoundaries: {
              crossEdges: same(carrying.length),
              crossingSymbols: same(beside.length),
              responsibilitiesTouched: [
                relationship.from,
                relationship.to,
              ].sort(),
              unresolvedEdges: same(0),
              withinEdges: same(0),
            },
          },
          id: scenarioId(
            "formalize-cross-responsibility-contract",
            beside.map((f) => f.symbolId),
            `contract-surface:${relationship.to}`
          ),
          kind: "formalize-cross-responsibility-contract",
          preservations: [
            "symbol-identity",
            "responsibility-ownership",
            "cross-responsibility-contract",
          ],
          proposed: {
            candidateModules: candidatesFound,
            exactPath: "deferred",
            responsibility: relationship.to,
            scope: "cross-responsibility-surface",
            surface: {
              consumerModules: sorted(carrying.map((e) => e.source)),
              deepModules: sorted(beside.map((f) => f.declaration.module)),
              responsibility: relationship.to,
              symbolIds: beside.map((f) => f.symbolId),
            },
          },
          provenance: contractProvenance,
          rationale: {
            facts: [
              `contracts: ${beside.map((f) => `${f.name} (${f.primaryRole})`).join(", ")}`,
              `${carrying.length} module edges carry them`,
              candidatesFound.length > 0
                ? `existing contract modules: ${candidatesFound.map((c) => c.module).join(", ")}`
                : "no dedicated contract module in the owning responsibility",
            ],
            sources: ["contract-beside-implementation"],
          },
          subject: contractSubject,
          uncertainties: [
            ...(beside.some((f) => packagePublic.has(f.symbolId))
              ? [
                  {
                    detail:
                      "a contract is package-public; external surface impact not evaluated",
                    reason: "package-public-external-impact" as const,
                  },
                ]
              : []),
            ...(candidatesFound.length === 0
              ? [
                  {
                    detail:
                      "no dedicated contract module exists in the owning responsibility",
                    reason: "target-module-unresolved" as const,
                  },
                ]
              : []),
          ],
        }
      );
    } else {
      candidate(
        "contract-beside-implementation",
        "formalize-cross-responsibility-contract",
        contractSubject,
        ineligible(
          [`${beside.length} contract-family symbol declared beside behavior`],
          [`${policy.contract.minimumSymbols}+ such symbols`]
        )
      );
    }
  }
}

function analyzeInternalRewiringEntriesEntries(
  relationship: ResponsibilityRelationship,
  policy: {
    compositionRoot: {
      minimumResponsibilities: number;
      maximumExportedSymbols: number;
      minimumWiringSites: number;
      minimumWiredResponsibilities: number;
    };
    orchestration: { maximumExportedSymbols: number };
    split: { minimumGroupSymbols: number };
    alignment: { minimumSupportRatio: number };
    closure: { largeShare: number };
    indirection: {
      maximumProviders: number;
      maximumExportedSymbols: number;
      maximumStatements: number;
    };
    surface: { minimumTargetModules: number; minimumSymbols: number };
    contract: { minimumSymbols: number };
    candidateModules: number;
    report: { topScenarios: number; topModules: number };
  },
  targetCandidates: () => ProposedArrangement["candidateModules"],
  ensureBaseline: (scenarioProvenance: ScenarioProvenance) => void,
  provenance: ScenarioProvenance,
  candidate: (
    source: CandidateSource,
    kind: InternalRewiringScenarioKind,
    subject: ScenarioSubject,
    eligibility: ScenarioEligibility,
    scenario?: InternalRewiringScenario
  ) => void,
  subject: ScenarioSubject,
  eligible: (reasons: string[]) => ScenarioEligibility,
  current: CurrentArrangement,
  responsibilities: InternalResponsibilityReport,
  crossing: ArchitecturalRoleFinding[],
  primaryModules: InternalModuleNode[],
  ineligible: (reasons: string[], missing: string[]) => ScenarioEligibility
) {
  if (relationship.targetModules.length >= 2) {
    const deep =
      relationship.targetModules.length >= policy.surface.minimumTargetModules;
    const enough = relationship.symbolFlow >= policy.surface.minimumSymbols;
    const candidatesFound = targetCandidates();
    analyzeInternalRewiringEntriesEntriesEntries(
      deep,
      enough,
      ensureBaseline,
      provenance,
      candidate,
      subject,
      eligible,
      relationship,
      current,
      responsibilities,
      crossing,
      primaryModules,
      candidatesFound,
      ineligible,
      policy
    );
  }
}

function analyzeInternalRewiringEntriesEntriesEntries(
  deep: boolean,
  enough: boolean,
  ensureBaseline: (scenarioProvenance: ScenarioProvenance) => void,
  provenance: ScenarioProvenance,
  candidate: (
    source: CandidateSource,
    kind: InternalRewiringScenarioKind,
    subject: ScenarioSubject,
    eligibility: ScenarioEligibility,
    scenario?: InternalRewiringScenario
  ) => void,
  subject: ScenarioSubject,
  eligible: (reasons: string[]) => ScenarioEligibility,
  relationship: ResponsibilityRelationship,
  current: CurrentArrangement,
  responsibilities: InternalResponsibilityReport,
  crossing: ArchitecturalRoleFinding[],
  primaryModules: InternalModuleNode[],
  candidatesFound: { module: string; evidence: TargetEvidence[] }[],
  ineligible: (reasons: string[], missing: string[]) => ScenarioEligibility,
  policy: {
    compositionRoot: {
      minimumResponsibilities: number;
      maximumExportedSymbols: number;
      minimumWiringSites: number;
      minimumWiredResponsibilities: number;
    };
    orchestration: { maximumExportedSymbols: number };
    split: { minimumGroupSymbols: number };
    alignment: { minimumSupportRatio: number };
    closure: { largeShare: number };
    indirection: {
      maximumProviders: number;
      maximumExportedSymbols: number;
      maximumStatements: number;
    };
    surface: { minimumTargetModules: number; minimumSymbols: number };
    contract: { minimumSymbols: number };
    candidateModules: number;
    report: { topScenarios: number; topModules: number };
  }
) {
  if (deep && enough) {
    ensureBaseline(provenance);
    candidate(
      "deep-responsibility-dependency",
      "formalize-responsibility-surface",
      subject,
      eligible([
        `${relationship.sourceModules.length} modules of ${relationship.from} reach ${relationship.targetModules.length} modules of ${relationship.to}`,
        `${relationship.symbolFlow} symbols cross`,
      ]),
      {
        current,
        effects: {
          conventions: {
            alignment: "no-applicable-convention",
            conventionIds: [],
          },
          cycles: {
            membership: [],
            outcome: responsibilities.regionCycles.some(
              (cycle) =>
                cycle.includes(relationship.from) &&
                cycle.includes(relationship.to)
            )
              ? "unchanged"
              : "none",
          },
          dependencies: {
            deepImports: {
              after: 1,
              before: relationship.targetModules.length,
            },
            edgesAdded: relationship.sourceModules.length,
            edgesRemoved: relationship.moduleEdges,
            edgesRetargeted: 0,
            modules: [],
          },
          locality: {
            after: "not-applicable",
            before: "not-applicable",
            symbols: crossing.length,
          },
          moduleComposition: {
            module: "",
            modules: {
              after:
                primaryModules.length + (candidatesFound.length === 0 ? 1 : 0),
              before: primaryModules.length,
            },
            roleGroups: same(0),
            scopeGroups: same(0),
          },
          responsibilityBoundaries: {
            crossEdges: {
              after: relationship.sourceModules.length,
              before: relationship.moduleEdges,
            },
            crossingSymbols: same(crossing.length),
            responsibilitiesTouched: [
              relationship.from,
              relationship.to,
            ].sort(),
            unresolvedEdges: same(0),
            withinEdges: same(0),
          },
        },
        id: scenarioId(
          "formalize-responsibility-surface",
          [subject.key],
          `surface:${relationship.to}`
        ),
        kind: "formalize-responsibility-surface",
        preservations: [
          "symbol-identity",
          "responsibility-ownership",
          "cross-responsibility-contract",
        ],
        proposed: {
          candidateModules: candidatesFound,
          exactPath: "deferred",
          responsibility: relationship.to,
          scope: "responsibility-surface",
          surface: {
            consumerModules: relationship.sourceModules,
            deepModules: relationship.targetModules,
            responsibility: relationship.to,
            symbolIds: crossing.map((f) => f.symbolId),
          },
        },
        provenance,
        rationale: {
          facts: [
            `${relationship.moduleEdges} module edges, ${relationship.mediatedEdges} already mediated by a re-export`,
            `crossing roles: ${Object.entries(roleCounts(crossing))
              .map(([r, n]) => `${n} ${r}`)
              .join(", ")}`,
            candidatesFound.length > 0
              ? `existing surface candidates: ${candidatesFound.map((c) => c.module).join(", ")}`
              : "no existing aggregator or contract module in the target responsibility",
          ],
          sources: ["deep-responsibility-dependency"],
        },
        subject,
        uncertainties: [
          ...(candidatesFound.length === 0
            ? [
                {
                  detail:
                    "no existing module matches a surface role in the target responsibility",
                  reason: "target-module-unresolved" as const,
                },
              ]
            : []),
          {
            detail:
              "whether the deep imports are intentional cannot be told without an internal anchor model",
            reason: "internal-anchors-unavailable" as const,
          },
        ],
      }
    );
  } else {
    candidate(
      "deep-responsibility-dependency",
      "formalize-responsibility-surface",
      subject,
      ineligible(
        [
          `${relationship.targetModules.length} target modules, ${relationship.symbolFlow} symbols`,
        ],
        [
          ...(deep
            ? []
            : [`${policy.surface.minimumTargetModules}+ target modules`]),
          ...(enough
            ? []
            : [`${policy.surface.minimumSymbols}+ crossing symbols`]),
        ]
      )
    );
  }
}

function simulateMoveEntries3(
  group: ArchitecturalRoleFinding[],
  consumersOf: Map<string, InternalSymbolConsumer[]>,
  module: string,
  edgeByKey: Map<string, InternalModuleEdge>,
  classifyEdge: (
    source: string,
    target: string
  ) => "within" | "cross" | "unresolved",
  targetModule: string | undefined,
  regionOf: (module: string) => string | undefined,
  targetRegion: string | undefined,
  closureOf: (group: string[], module: string) => SymbolMovementClosure,
  moduleNode: Map<string, InternalModuleNode>,
  stillCyclic: (module: string, removed: Set<string>) => boolean,
  reaches: (from: string, goal: (module: string) => boolean) => boolean,
  moduleFinding: Map<string, PrimitiveModuleFinding>,
  findingsByModule: Map<string, ArchitecturalRoleFinding[]>,
  conventions: { alignment: ConventionAlignment; conventionIds: string[] },
  after: LocalityRelation,
  before: LocalityRelation,
  primaryModules: InternalModuleNode[]
): MoveSimulation {
  const ids = new Set(group.map((f) => f.symbolId));
  const touched = new Map<string, Set<string>>();
  simulateMoveFinding(group, consumersOf, module, touched);
  const counts = {
    cross: { after: 0, before: 0 },
    unresolved: { after: 0, before: 0 },
    within: { after: 0, before: 0 },
  };
  const removed = new Set<string>();
  let retargeted = 0;
  let added = 0;
  const consumers = new Set<string>();
  const edgeList: MoveSimulation["edges"] = [];
  ({ retargeted, added } = simulateMoveEntries(
    touched,
    edgeByKey,
    consumers,
    ids,
    counts,
    classifyEdge,
    removed,
    retargeted,
    edgeList,
    targetModule,
    added,
    regionOf,
    targetRegion
  ));
  const closure = closureOf([...ids], module);
  const reverse = closure.blockers.some(
    (b) => b.reason === "reverse-dependency"
  );
  const back = closure.optional.length > 0;
  if (reverse) {
    added += 1;
  }
  if (back) {
    added += 1;
  }
  const node = moduleNode.get(module);
  // A consumer reaching the group through a re-export loses its edge to
  // the forwarding module, not to the declaring one.
  const removedByTarget = new Map<string, Set<string>>();
  simulateMoveKey(removed, removedByTarget);
  const fanInAfter =
    (node?.fanIn ?? 0) - (removedByTarget.get(module)?.size ?? 0);
  const forwarding = [...removedByTarget.entries()]
    .filter(([target]) => target !== module)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([target, sources]) => {
      const via = moduleNode.get(target);
      return {
        fanIn: {
          after: (via?.fanIn ?? 0) - sources.size,
          before: via?.fanIn ?? 0,
        },
        fanOut: same(via?.fanOut ?? 0),
        module: target,
      };
    });
  const membership = node?.cycle === undefined ? [] : [node.cycle];
  let outcome: CycleOutcome = membership.length === 0 ? "none" : "unchanged";
  let detail: string | undefined;
  if (membership.length > 0 && !stillCyclic(module, removed)) {
    outcome = "membership-removed";
    detail = `${module} leaves ${membership[0] ?? ""} once ${removed.size} edges go`;
  }
  const reachesTarget =
    targetRegion === undefined
      ? reaches(module, (m) => consumers.has(m))
      : reaches(module, (m) => regionOf(m) === targetRegion);
  ({ outcome, detail } = simulateMoveEntries2(
    back,
    reachesTarget,
    outcome,
    detail,
    closure,
    module,
    reverse,
    retargeted
  ));
  const declaringRegion = regionOf(module);
  const crossingBefore = group.filter((f) =>
    f.consumers.responsibilities.some((r) => r !== declaringRegion)
  ).length;
  const crossingAfter =
    targetRegion === undefined
      ? crossingBefore
      : group.filter((f) =>
          f.consumers.responsibilities.some((r) => r !== targetRegion)
        ).length;
  const finding = moduleFinding.get(module);
  const exported = (findingsByModule.get(module) ?? []).filter(
    (f) => f.exported
  );
  const stayingExported = exported.filter((f) => !ids.has(f.symbolId));
  const groupKeys = new Set(exported.map(scopeGroupKey));
  const stayingKeys = new Set(stayingExported.map(scopeGroupKey));
  const rolesBefore = new Set(
    exported
      .filter((f) => f.primaryRole !== "unknown")
      .map((f) => f.primaryRole)
  );
  const rolesAfter = new Set(
    stayingExported
      .filter((f) => f.primaryRole !== "unknown")
      .map((f) => f.primaryRole)
  );
  const responsibilitiesTouched = sorted([
    ...(declaringRegion === undefined ? [] : [declaringRegion]),
    ...(targetRegion === undefined ? [] : [targetRegion]),
    ...group.flatMap((f) => f.consumers.responsibilities),
  ]);
  return simulateMoveEntries3Entries(
    closure,
    edgeList,
    conventions,
    membership,
    outcome,
    detail,
    added,
    removed,
    retargeted,
    fanInAfter,
    node,
    reverse,
    module,
    forwarding,
    after,
    before,
    group,
    primaryModules,
    targetModule,
    rolesAfter,
    rolesBefore,
    finding,
    groupKeys,
    stayingKeys,
    counts,
    crossingAfter,
    crossingBefore,
    responsibilitiesTouched
  );
}

function simulateMoveEntries3Entries(
  closure: SymbolMovementClosure,
  edgeList: { source: string; target: string; symbolIds: string[] }[],
  conventions: { alignment: ConventionAlignment; conventionIds: string[] },
  membership: string[],
  outcome: CycleOutcome,
  detail: string | undefined,
  added: number,
  removed: Set<string>,
  retargeted: number,
  fanInAfter: number,
  node: InternalModuleNode | undefined,
  reverse: boolean,
  module: string,
  forwarding: {
    fanIn: { after: number; before: number };
    fanOut: BeforeAfter;
    module: string;
  }[],
  after: LocalityRelation,
  before: LocalityRelation,
  group: ArchitecturalRoleFinding[],
  primaryModules: InternalModuleNode[],
  targetModule: string | undefined,
  rolesAfter: Set<ArchitecturalRole>,
  rolesBefore: Set<ArchitecturalRole>,
  finding: PrimitiveModuleFinding | undefined,
  groupKeys: Set<string>,
  stayingKeys: Set<string>,
  counts: {
    cross: { after: number; before: number };
    unresolved: { after: number; before: number };
    within: { after: number; before: number };
  },
  crossingAfter: number,
  crossingBefore: number,
  responsibilitiesTouched: string[]
): MoveSimulation {
  return {
    closure,
    edges: edgeList,
    effects: {
      conventions,
      cycles: {
        membership,
        outcome,
        ...(detail !== undefined && { detail }),
      },
      dependencies: {
        edgesAdded: added,
        edgesRemoved: removed.size,
        edgesRetargeted: retargeted,
        modules: [
          {
            fanIn: { after: fanInAfter, before: node?.fanIn ?? 0 },
            fanOut: {
              after: (node?.fanOut ?? 0) + (reverse ? 1 : 0),
              before: node?.fanOut ?? 0,
            },
            module,
          },
          ...forwarding,
        ],
      },
      locality: { after, before, symbols: group.length },
      moduleComposition: {
        module,
        modules: {
          after: primaryModules.length + (targetModule === undefined ? 1 : 0),
          before: primaryModules.length,
        },
        roleGroups: { after: rolesAfter.size, before: rolesBefore.size },
        scopeGroups: {
          after:
            (finding?.composition.scopeGroups ?? groupKeys.size) -
            (groupKeys.size - stayingKeys.size),
          before: finding?.composition.scopeGroups ?? groupKeys.size,
        },
      },
      responsibilityBoundaries: {
        crossEdges: counts.cross,
        crossingSymbols: { after: crossingAfter, before: crossingBefore },
        responsibilitiesTouched,
        unresolvedEdges: counts.unresolved,
        withinEdges: counts.within,
      },
    },
  };
}

function splitScenarioEntries2(
  separated: ScopeGroup[],
  findingById: Map<string, ArchitecturalRoleFinding>,
  remainderOf: (separated: ScopeGroup[]) => ScopeGroup[],
  candidateModulesFor: (
    group: ArchitecturalRoleFinding[],
    region: string | undefined,
    scope: ArchitecturalScopeClass
  ) => ProposedArrangement["candidateModules"],
  dominantRole: (findings: ArchitecturalRoleFinding[]) => ArchitecturalRole,
  alignmentOf: (
    role: ArchitecturalRole,
    scope: ArchitecturalScopeClass,
    dimension: ConventionDimension,
    matching: string[]
  ) => { alignment: ConventionAlignment; ids: string[] },
  simulateMove: (
    group: ArchitecturalRoleFinding[],
    module: string,
    targetRegion: string | undefined,
    targetModule: string | undefined,
    before: LocalityRelation,
    after: LocalityRelation,
    conventions: InternalRewiringEffects["conventions"]
  ) => MoveSimulation,
  module: string,
  localityOf: (finding: ArchitecturalRoleFinding) => LocalityRelation,
  closureOf: (group: string[], module: string) => SymbolMovementClosure,
  localDependencies: (
    symbolId: string
  ) => { symbolId: string; relationship: ClosureRelationship }[],
  node: InternalModuleNode | undefined,
  edgeByKey: Map<string, InternalModuleEdge>,
  finding: PrimitiveModuleFinding,
  primaryModules: InternalModuleNode[],
  exported: ArchitecturalRoleFinding[],
  roleList: RoleGroup[],
  scoped: (g: ScopeGroup) => boolean,
  symbolUncertainties: (
    group: ArchitecturalRoleFinding[],
    module: string,
    closure: SymbolMovementClosure | undefined,
    movement: boolean,
    targetKnown: boolean
  ) => ScenarioUncertainty[],
  variant: "partial" | "full",
  current: CurrentArrangement,
  isRoot: (module: string) => boolean,
  moduleProvenance: (
    group: ArchitecturalRoleFinding[],
    edges: { source: string; target: string }[],
    regions: (string | undefined)[],
    conventionIds: string[]
  ) => ScenarioProvenance,
  localGroups: ScopeGroup[],
  subject: ScenarioSubject
): InternalRewiringScenario {
  const moving = separated
    .flatMap((g) => g.symbolIds.map((id) => findingById.get(id)))
    .filter((f): f is ArchitecturalRoleFinding => f !== undefined);
  const remainder = remainderOf(separated);
  // Effects: each group moves toward its responsibility; sum over groups.
  const simulations = separated.flatMap((g) => {
    const members = g.symbolIds
      .map((id) => findingById.get(id))
      .filter((f): f is ArchitecturalRoleFinding => f !== undefined);
    const [head] = members;
    if (head === undefined) {
      return [];
    }
    const targets =
      separated.length === 1
        ? candidateModulesFor(members, g.responsibility, "responsibility-local")
        : [];
    const role = dominantRole(members);
    const directory = alignmentOf(role, "responsibility-local", "directory", [
      "inside-responsibility",
      "responsibility-root",
      "dedicated-role-directory",
    ]);
    return [
      {
        group: g,
        simulation: simulateMove(
          members,
          module,
          g.responsibility,
          targets.length === 1 ? targets[0]?.module : undefined,
          localityOf(head),
          "declared-in-serving-responsibility",
          {
            alignment: directory.alignment,
            conventionIds: directory.ids,
          }
        ),
        targets,
      },
    ];
  });
  const sum = (pick: (s: MoveSimulation) => BeforeAfter): BeforeAfter =>
    simulations.reduce(
      (acc, s) => ({
        after: acc.after + pick(s.simulation).after,
        before: acc.before + pick(s.simulation).before,
      }),
      { after: 0, before: 0 }
    );
  const closure = closureOf(
    moving.map((f) => f.symbolId),
    module
  );
  const crossGroup = separated.some((a) =>
    a.symbolIds.some((id) =>
      localDependencies(id).some((dep) =>
        separated.some((b) => b !== a && b.symbolIds.includes(dep.symbolId))
      )
    )
  );
  const alignments = simulations.map((s) => s.simulation.effects.conventions);
  const alignment: ConventionAlignment = alignments.every(
    (a) => a.alignment === alignments[0]?.alignment
  )
    ? (alignments[0]?.alignment ?? "no-applicable-convention")
    : "competing-convention";
  const removedEdges = simulations.reduce(
    (n, s) => n + s.simulation.effects.dependencies.edgesRemoved,
    0
  );
  const cycles = simulations.map((s) => s.simulation.effects.cycles);

  const outcome: CycleOutcome = splitScenarioEntries(cycles);
  const targetKnown = simulations.every((s) => s.targets.length > 0);
  const effects: InternalRewiringEffects = {
    conventions: {
      alignment,
      conventionIds: sorted(alignments.flatMap((a) => a.conventionIds)),
    },
    cycles: {
      membership: node?.cycle === undefined ? [] : [node.cycle],
      outcome,
      ...(cycles.find((c) => c.detail !== undefined)?.detail !== undefined && {
        detail: cycles.find((c) => c.detail !== undefined)?.detail,
      }),
    },
    dependencies: {
      edgesAdded: simulations.reduce(
        (n, s) => n + s.simulation.effects.dependencies.edgesAdded,
        0
      ),
      edgesRemoved: removedEdges,
      edgesRetargeted: simulations.reduce(
        (n, s) => n + s.simulation.effects.dependencies.edgesRetargeted,
        0
      ),
      modules: [
        {
          fanIn: {
            after:
              (node?.fanIn ?? 0) -
              new Set(
                simulations.flatMap((s) =>
                  s.simulation.edges
                    .filter(
                      (e) =>
                        e.target === module &&
                        edgeByKey
                          .get(`${e.source}→${e.target}`)
                          ?.symbols.every(
                            (sym) =>
                              sym.symbolId !== undefined &&
                              moving.some((f) => f.symbolId === sym.symbolId)
                          )
                    )
                    .map((e) => e.source)
                )
              ).size,
            before: node?.fanIn ?? 0,
          },
          fanOut: same(node?.fanOut ?? 0),
          module,
        },
      ],
    },
    locality: {
      after: "declared-in-serving-responsibility",
      before:
        finding.status === "unresolved"
          ? "declared-in-unresolved-module"
          : "declared-outside-serving-responsibility",
      symbols: moving.length,
    },
    moduleComposition: {
      module,
      modules: {
        after:
          primaryModules.length +
          simulations.filter((s) => s.targets.length === 0).length,
        before: primaryModules.length,
      },
      roleGroups: {
        after: roleGroups(
          exported.filter(
            (f) => f.primaryRole !== "unknown" && !moving.includes(f)
          )
        ).length,
        before: roleList.length,
      },
      scopeGroups: {
        after: remainder.filter((g) => scoped(g)).length,
        before: finding.composition.scopeGroups,
      },
    },
    responsibilityBoundaries: {
      crossEdges: sum((s) => s.effects.responsibilityBoundaries.crossEdges),
      crossingSymbols: sum(
        (s) => s.effects.responsibilityBoundaries.crossingSymbols
      ),
      responsibilitiesTouched: sorted(
        simulations.flatMap(
          (s) =>
            s.simulation.effects.responsibilityBoundaries
              .responsibilitiesTouched
        )
      ),
      unresolvedEdges: sum(
        (s) => s.effects.responsibilityBoundaries.unresolvedEdges
      ),
      withinEdges: sum((s) => s.effects.responsibilityBoundaries.withinEdges),
    },
  };
  const uncertainties = symbolUncertainties(
    moving,
    module,
    closure,
    true,
    targetKnown
  );
  if (crossGroup) {
    uncertainties.push({
      detail: "a separated group depends on another separated group",
      reason: "closure-crosses-groups",
    });
  }
  uncertainties.sort(
    (a, b) => UNCERTAINTIES.indexOf(a.reason) - UNCERTAINTIES.indexOf(b.reason)
  );
  const target = `split:${variant}:${separated.map((g) => g.key).join(",")}`;
  return {
    closure,
    current,
    effects,
    id: scenarioId("split-module-by-responsibility", [module], target),
    kind: "split-module-by-responsibility",
    preservations: [
      "symbol-identity",
      ...(remainder.some((g) => g.scope === "package-wide")
        ? (["package-wide-scope"] as RewiringPreservation[])
        : []),
      ...(remainder.some((g) => g.scope === "cross-responsibility")
        ? (["cross-responsibility-contract"] as RewiringPreservation[])
        : []),
      ...(isRoot(module)
        ? (["composition-role"] as RewiringPreservation[])
        : []),
      ...(outcome === "unchanged"
        ? (["cycle-atomicity"] as RewiringPreservation[])
        : []),
    ],
    proposed: {
      candidateModules:
        simulations.length === 1 ? (simulations[0]?.targets ?? []) : [],
      exactPath: "deferred",
      remainder,
      scope: "responsibility-local",
      separated,
    },
    provenance: moduleProvenance(
      moving,
      simulations.flatMap((s) => s.simulation.edges),
      separated.map((g) => g.responsibility),
      sorted(alignments.flatMap((a) => a.conventionIds))
    ),
    rationale: {
      facts: [
        `${finding.composition.scopeGroups} scope groups among ${exported.length} exported symbols`,
        `${variant}: separate ${separated.length} of ${localGroups.length} responsibility-local groups (${moving.length} symbols)`,
        `remainder keeps ${remainder.reduce((n, g) => n + g.symbolIds.length, 0)} symbols: ${remainder.map((g) => `${g.symbolIds.length} ${g.key.replace(splitScenarioPattern, "local to ")}`).join(", ")}`,
      ],
      sources: ["mixed-scope"],
    },
    subject,
    uncertainties,
  };
}

function resolveAnalyzeInternalRewiring3(
  simulation: MoveSimulation | undefined,
  current: CurrentArrangement,
  subject: ScenarioSubject,
  scope: "cross-responsibility" | "package-wide",
  basePreservations: RewiringPreservation[],
  group: ArchitecturalRoleFinding[],
  targetModules: { module: string; evidence: TargetEvidence[] }[],
  provenance: ScenarioProvenance,
  facts: string[],
  source: "cross-responsibility" | "package-wide",
  symbolUncertainties: (
    group: ArchitecturalRoleFinding[],
    module: string,
    closure: SymbolMovementClosure | undefined,
    movement: boolean,
    targetKnown: boolean
  ) => ScenarioUncertainty[],
  module: string
): InternalRewiringScenario | undefined {
  if (simulation === undefined) {
    return undefined;
  }
  return {
    closure: simulation.closure,
    current,
    effects: simulation.effects,
    id: scenarioId("promote-primitive", subject.symbolIds ?? [], scope),
    kind: "promote-primitive",
    // Promotion places the group at the scope its consumers measured, so that scope survives by construction.
    preservations: [
      ...basePreservations,
      ...resolvePreservations(scope, group),
      ...(simulation.effects.cycles.outcome === "unchanged"
        ? (["cycle-atomicity"] as RewiringPreservation[])
        : []),
    ],
    proposed: {
      candidateModules: targetModules,
      exactPath: "deferred",
      scope,
    },
    provenance,
    rationale: { facts, sources: [source] },
    subject,
    uncertainties: symbolUncertainties(
      group,
      module,
      simulation.closure,
      true,
      targetModules.length > 0
    ),
  };
}

function resolvePreservations(
  scope: "cross-responsibility" | "package-wide",
  group: ArchitecturalRoleFinding[]
): RewiringPreservation[] {
  if (scope === "package-wide") {
    return ["package-wide-scope"] as RewiringPreservation[];
  }
  if (group.some((f) => CONTRACT_FAMILY.includes(f.primaryRole))) {
    return ["cross-responsibility-contract"] as RewiringPreservation[];
  }
  return [];
}

function resolveAnalyzeInternalRewiring2(
  holds: boolean,
  currentOfGroup: (
    group: ArchitecturalRoleFinding[],
    module: string
  ) => CurrentArrangement,
  contracts: ArchitecturalRoleFinding[],
  module: string,
  noEffects: (
    module: string | undefined,
    symbols: number,
    relationLocality: LocalityRelation,
    conventions?: InternalRewiringEffects["conventions"]
  ) => InternalRewiringEffects,
  localityOf: (finding: ArchitecturalRoleFinding) => LocalityRelation,
  first: ArchitecturalRoleFinding,
  noConvention: {
    alignment: "no-applicable-convention";
    conventionIds: never[];
  },
  preserveSubject: ScenarioSubject,
  declaringRegion: string | undefined,
  basePreservations: RewiringPreservation[],
  provenance: ScenarioProvenance,
  factsOfGroup: (group: ArchitecturalRoleFinding[]) => string[],
  source: "cross-responsibility" | "package-wide",
  symbolUncertainties: (
    group: ArchitecturalRoleFinding[],
    module: string,
    closure: SymbolMovementClosure | undefined,
    movement: boolean,
    targetKnown: boolean
  ) => ScenarioUncertainty[]
): InternalRewiringScenario | undefined {
  if (holds) {
    return {
      current: currentOfGroup(contracts, module),
      effects: noEffects(
        module,
        contracts.length,
        localityOf(first),
        noConvention
      ),
      id: scenarioId(
        "preserve-cross-responsibility-contract",
        preserveSubject.symbolIds ?? [],
        "cross-responsibility"
      ),
      kind: "preserve-cross-responsibility-contract",
      preservations: [
        "module-identity",
        "cross-responsibility-contract",
        ...(declaringRegion === undefined
          ? []
          : (["responsibility-ownership"] as RewiringPreservation[])),
        ...basePreservations,
      ],
      proposed: {
        scope: "cross-responsibility",
        ...(declaringRegion !== undefined && {
          responsibility: declaringRegion,
        }),
        candidateModules: [],
        exactPath: "deferred",
      },
      provenance,
      rationale: {
        facts: factsOfGroup(contracts),
        sources: [source],
      },
      subject: preserveSubject,
      uncertainties: symbolUncertainties(
        contracts,
        module,
        undefined,
        false,
        true
      ),
    };
  }
  return undefined;
}

function resolveAnalyzeInternalRewiring(
  holds: boolean,
  eligible: (reasons: string[]) => ScenarioEligibility,
  contracts: ArchitecturalRoleFinding[],
  foreign: string[],
  ownedByConsumer: boolean,
  first: ArchitecturalRoleFinding,
  dedicated: boolean,
  ineligible: (reasons: string[], missing: string[]) => ScenarioEligibility
): ScenarioEligibility {
  if (holds) {
    return eligible([
      `${contracts.length} contract-family symbols shared by ${foreign.length + (ownedByConsumer ? 1 : 0)} responsibilities`,
      resolveResolveAnalyzeInternalRewiring(first, dedicated),
    ]);
  }
  return ineligible(
    ["declared in a responsibility that does not consume it"],
    ["ownership by a consumer, a dedicated-role module, or a hub"]
  );
}

function resolveResolveAnalyzeInternalRewiring(
  first: ArchitecturalRoleFinding,
  dedicated: boolean
): string {
  if (first.declaration.placed) {
    if (dedicated) {
      return "declared in a dedicated-role module";
    }
    return "owned by a consuming responsibility";
  }
  return "declared in an unresolved module";
}

function closureOfEntries(
  queue: string[],
  visited: Set<string>,
  dependsOn: Map<string, Map<string, Set<ClosureRelationship>>>,
  moving: Set<string>,
  findingById: Map<string, ArchitecturalRoleFinding>,
  optional: Map<string, Set<ClosureRelationship>>,
  usedByStaying: (id: string) => boolean,
  blockers: Map<
    string,
    "shared-module-local-dependency" | "reverse-dependency"
  >,
  required: Map<string, Set<ClosureRelationship>>
) {
  while (queue.length > 0) {
    const current = queue.shift() ?? "";
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    closureOfEntriesEntries(
      dependsOn,
      current,
      moving,
      findingById,
      optional,
      usedByStaying,
      blockers,
      required,
      queue
    );
  }
}

function closureOfEntriesEntries(
  dependsOn: Map<string, Map<string, Set<ClosureRelationship>>>,
  current: string,
  moving: Set<string>,
  findingById: Map<string, ArchitecturalRoleFinding>,
  optional: Map<string, Set<ClosureRelationship>>,
  usedByStaying: (id: string) => boolean,
  blockers: Map<
    string,
    "shared-module-local-dependency" | "reverse-dependency"
  >,
  required: Map<string, Set<ClosureRelationship>>,
  queue: string[]
) {
  for (const [target, kinds] of dependsOn.get(current) ?? []) {
    if (moving.has(target)) {
      continue;
    }
    const exported = findingById.get(target)?.exported === true;
    if (exported) {
      const set = optional.get(target) ?? new Set();
      for (const kind of kinds) {
        set.add(kind);
      }
      optional.set(target, set);
    } else if (usedByStaying(target)) {
      blockers.set(target, "shared-module-local-dependency");
    } else {
      const set = required.get(target) ?? new Set();
      for (const kind of kinds) {
        set.add(kind);
      }
      required.set(target, set);
      queue.push(target);
    }
  }
}

function candidateModulesForModule(
  primitives: PrimitiveConventionReport,
  findingsByModule: Map<string, ArchitecturalRoleFinding[]>,
  scope: ArchitecturalScopeClass,
  roles: Set<ArchitecturalRole>,
  add: (module: string, evidence: TargetEvidence) => void
) {
  for (const module of primitives.modules) {
    if (!module.shapes.some((s) => s.endsWith("-hub"))) {
      continue;
    }
    const exported = (findingsByModule.get(module.module) ?? []).filter(
      (f) => f.exported && f.scope === scope && roles.has(f.primaryRole)
    );
    if (exported.length === 0) {
      continue;
    }
    add(module.module, "existing-hub");
    if (
      module.composition.roles === "single-role" &&
      module.composition.dominantRole !== undefined &&
      roles.has(module.composition.dominantRole.role)
    ) {
      add(module.module, "dedicated-role-module");
    }
  }
}

function simulateMoveEntries2(
  back: boolean,
  reachesTarget: boolean,
  initialOutcome: CycleOutcome,
  initialDetail: string | undefined,
  closure: SymbolMovementClosure,
  module: string,
  reverse: boolean,
  retargeted: number
): { outcome: CycleOutcome; detail: string | undefined } {
  let detail = initialDetail;
  let outcome = initialOutcome;
  if (back && reachesTarget) {
    outcome = "potential-new-cycle";
    detail = `${closure.optional.length} exported dependencies stay in ${module}, which already reaches the target scope`;
  } else if (reverse && retargeted > 0) {
    outcome = "potential-new-cycle";
    detail = `${module} would import the group back while consumers of the group still import ${module}`;
  }
  return { detail, outcome };
}

function simulateMoveKey(
  removed: Set<string>,
  removedByTarget: Map<string, Set<string>>
) {
  for (const key of removed) {
    const [source, target] = key.split("→");
    if (source === undefined || target === undefined) {
      continue;
    }
    const set = removedByTarget.get(target) ?? new Set();
    set.add(source);
    removedByTarget.set(target, set);
  }
}

function simulateMoveFinding(
  group: ArchitecturalRoleFinding[],
  consumersOf: Map<string, InternalSymbolConsumer[]>,
  module: string,
  touched: Map<string, Set<string>>
) {
  for (const finding of group) {
    for (const consumer of consumersOf.get(finding.symbolId) ?? []) {
      const key = `${consumer.module}→${consumer.via ?? module}`;
      const set = touched.get(key) ?? new Set();
      set.add(finding.symbolId);
      touched.set(key, set);
    }
  }
}

function simulateMoveEntries(
  touched: Map<string, Set<string>>,
  edgeByKey: Map<string, InternalModuleEdge>,
  consumers: Set<string>,
  ids: Set<string>,
  counts: {
    cross: { after: number; before: number };
    unresolved: { after: number; before: number };
    within: { after: number; before: number };
  },
  classifyEdge: (
    source: string,
    target: string
  ) => "within" | "cross" | "unresolved",
  removed: Set<string>,
  initialRetargeted: number,
  edgeList: { source: string; target: string; symbolIds: string[] }[],
  targetModule: string | undefined,
  initialAdded: number,
  regionOf: (module: string) => string | undefined,
  targetRegion: string | undefined
): { retargeted: number; added: number } {
  let added = initialAdded;
  let retargeted = initialRetargeted;
  for (const [key, covered] of [...touched.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const edge = edgeByKey.get(key);
    if (edge === undefined) {
      continue;
    }
    consumers.add(edge.source);
    const fully = edge.symbols.every(
      (s) => s.symbolId !== undefined && ids.has(s.symbolId)
    );
    counts[classifyEdge(edge.source, edge.target)].before += 1;
    if (fully) {
      removed.add(key);
    } else {
      retargeted += 1;
      counts[classifyEdge(edge.source, edge.target)].after += 1;
    }
    edgeList.push({
      source: edge.source,
      symbolIds: sorted(covered),
      target: edge.target,
    });
    if (edge.source !== targetModule) {
      added += 1;
      const sourceRegion = regionOf(edge.source);
      let kind: "unresolved" | "within" | "cross";
      if (sourceRegion === undefined || targetRegion === undefined) {
        kind = "unresolved";
      } else if (sourceRegion === targetRegion) {
        kind = "within";
      } else {
        kind = "cross";
      }
      counts[kind].after += 1;
    }
  }
  return { added, retargeted };
}

function symbolUncertaintiesEntries(
  movement: boolean,
  group: ArchitecturalRoleFinding[],
  findingsByModule: Map<string, ArchitecturalRoleFinding[]>,
  module: string,
  out: ScenarioUncertainty[],
  closure: SymbolMovementClosure | undefined,
  moduleNode: Map<string, InternalModuleNode>,
  isRoot: (module: string) => boolean,
  targetKnown: boolean
) {
  if (movement) {
    const ids = new Set(group.map((f) => f.symbolId));
    const stayingExecutable = (findingsByModule.get(module) ?? []).filter(
      (f) => !ids.has(f.symbolId) && EXECUTABLE_ROLES.includes(f.primaryRole)
    );
    if (stayingExecutable.length > 0) {
      out.push({
        detail: `${stayingExecutable.length} executable declarations stay in ${module}; references inside function bodies are not measured`,
        reason: "movement-closure-incomplete",
      });
    }
    if (closure?.size === "large") {
      out.push({
        detail: `moving ${closure.subject.length} symbols pulls ${closure.required.length} required and ${closure.optional.length} optional declarations`,
        reason: "large-closure",
      });
    }
    if (closure?.size === "unresolved") {
      out.push({
        detail: closure.blockers
          .map((b) => `${b.symbolId.split("#")[1] ?? b.symbolId}: ${b.reason}`)
          .join("; "),
        reason: "closure-blocked",
      });
    }
    const node = moduleNode.get(module);
    if (node?.cycle !== undefined) {
      out.push({
        detail: `${module} is a member of ${node.cycle}`,
        reason: "cycle-membership",
      });
    }
    if (isRoot(module)) {
      out.push({
        detail: `${module} is a composition root; the move leaves its wiring in place`,
        reason: "composition-root-membership",
      });
    }
    if (!targetKnown) {
      out.push({
        detail: "no existing module matches the intended role and scope",
        reason: "target-module-unresolved",
      });
    }
    out.push({
      detail:
        "no internal anchor model; a boundary that is intentional cannot be told from one that is incidental",
      reason: "internal-anchors-unavailable",
    });
  }
}

function splitScenarioEntries(
  cycles: { membership: string[]; outcome: CycleOutcome; detail?: string }[]
): CycleOutcome {
  let outcome: CycleOutcome;
  if (cycles.some((c) => c.outcome === "potential-new-cycle")) {
    outcome = "potential-new-cycle";
  } else if (cycles.some((c) => c.outcome === "membership-removed")) {
    outcome = "membership-removed";
  } else {
    outcome = cycles[0]?.outcome ?? "none";
  }
  return outcome;
}

function summarize(
  scenarios: InternalRewiringScenario[],
  candidates: ScenarioCandidate[],
  families: ScenarioFamily[],
  composition: CompositionEvidence[],
  responsibilities: InternalResponsibilityReport
): InternalRewiringSummary {
  const byKind = zeroRecord(KINDS);
  const bySubjectKind = zeroRecord(SUBJECT_KINDS);
  const conventions = zeroRecord(ALIGNMENTS);
  const cycles = zeroRecord(CYCLE_OUTCOMES);
  const closures = zeroRecord(CLOSURE_SIZES);
  const byPreservation = zeroRecord(PRESERVATIONS);
  const byUncertainty = zeroRecord(UNCERTAINTIES);
  const effects = {
    crossEdgesIncreased: 0,
    crossEdgesReduced: 0,
    localDeclarationsMoved: 0,
    packageWidePreserved: 0,
    unresolvedEdgesReduced: 0,
  };
  summarizeScenario(
    scenarios,
    byKind,
    bySubjectKind,
    conventions,
    cycles,
    closures,
    byPreservation,
    byUncertainty,
    effects
  );
  const familyKeys = new Set(families.map((f) => f.subject.key));
  const ineligibleSubjects = new Set(
    candidates
      .filter((c) => !c.eligibility.eligible)
      .map((c) => c.subject.key)
      .filter((key) => !familyKeys.has(key))
  );
  const byRole = zeroRecord(COMPOSITION_ROLES);
  for (const entry of composition) {
    for (const role of entry.roles) {
      byRole[role] += 1;
    }
  }
  const wideDependents = responsibilities.unresolved.filter(
    (u) => u.reason === "wide-dependent"
  );
  const compositionByModule = new Map(composition.map((c) => [c.module, c]));
  return {
    byKind,
    byPreservation,
    bySubjectKind,
    byUncertainty,
    candidates: {
      eligible: candidates.filter((c) => c.eligibility.eligible).length,
      ineligible: candidates.filter((c) => !c.eligibility.eligible).length,
      total: candidates.length,
    },
    closures,
    composition: {
      byRole,
      modules: composition.filter((c) => c.responsibilities.length >= 2).length,
      roots: composition.filter((c) => c.compositionRoot).length,
      wideDependents: {
        roots: wideDependents.filter(
          (u) => compositionByModule.get(u.module)?.compositionRoot === true
        ).length,
        total: wideDependents.length,
        unclear: wideDependents.filter((u) =>
          compositionByModule.get(u.module)?.roles.includes("unclear")
        ).length,
      },
    },
    conventions,
    cycles,
    effects,
    families: {
      insufficientEvidence: ineligibleSubjects.size,
      preservationOnly: families.filter((f) => f.preservationOnly).length,
      total: families.length,
      withAlternatives: families.filter((f) => !f.preservationOnly).length,
    },
    scenarios: scenarios.length,
  };
}

function summarizeScenario(
  scenarios: InternalRewiringScenario[],
  byKind: Record<InternalRewiringScenarioKind, number>,
  bySubjectKind: Record<ScenarioSubjectKind, number>,
  conventions: Record<ConventionAlignment, number>,
  cycles: Record<CycleOutcome, number>,
  closures: Record<ClosureSize, number>,
  byPreservation: Record<RewiringPreservation, number>,
  byUncertainty: Record<ScenarioUncertaintyReason, number>,
  effects: {
    crossEdgesIncreased: number;
    crossEdgesReduced: number;
    localDeclarationsMoved: number;
    packageWidePreserved: number;
    unresolvedEdgesReduced: number;
  }
) {
  for (const scenario of scenarios) {
    summarizeScenarioEntries(
      byKind,
      scenario,
      bySubjectKind,
      conventions,
      cycles,
      closures,
      byPreservation,
      byUncertainty,
      effects
    );
  }
}

function summarizeScenarioEntries(
  byKind: Record<InternalRewiringScenarioKind, number>,
  scenario: InternalRewiringScenario,
  bySubjectKind: Record<ScenarioSubjectKind, number>,
  conventions: Record<ConventionAlignment, number>,
  cycles: Record<CycleOutcome, number>,
  closures: Record<ClosureSize, number>,
  byPreservation: Record<RewiringPreservation, number>,
  byUncertainty: Record<ScenarioUncertaintyReason, number>,
  effects: {
    crossEdgesIncreased: number;
    crossEdgesReduced: number;
    localDeclarationsMoved: number;
    packageWidePreserved: number;
    unresolvedEdgesReduced: number;
  }
) {
  byKind[scenario.kind] += 1;
  bySubjectKind[scenario.subject.kind] += 1;
  if (!PRESERVING_KINDS.includes(scenario.kind)) {
    conventions[scenario.effects.conventions.alignment] += 1;
    cycles[scenario.effects.cycles.outcome] += 1;
  }
  if (scenario.closure !== undefined) {
    closures[scenario.closure.size] += 1;
  }
  for (const p of scenario.preservations) {
    byPreservation[p] += 1;
  }
  for (const u of scenario.uncertainties) {
    byUncertainty[u.reason] += 1;
  }
  const cross = scenario.effects.responsibilityBoundaries.crossEdges;
  if (cross.after < cross.before) {
    effects.crossEdgesReduced += 1;
  }
  if (cross.after > cross.before) {
    effects.crossEdgesIncreased += 1;
  }
  const unresolved = scenario.effects.responsibilityBoundaries.unresolvedEdges;
  if (unresolved.after < unresolved.before) {
    effects.unresolvedEdgesReduced += 1;
  }
  if (
    scenario.kind === "demote-primitive" ||
    scenario.kind === "colocate-primitive"
  ) {
    effects.localDeclarationsMoved += scenario.subject.symbolIds?.length ?? 0;
  }
  if (scenario.kind === "preserve-package-primitive") {
    effects.packageWidePreserved += scenario.subject.symbolIds?.length ?? 0;
  }
}

export function getRewiringScenario(
  report: InternalRewiringReport,
  id: string
): InternalRewiringScenario | undefined {
  return report.scenarios.find((scenario) => scenario.id === id);
}

export function getScenariosForSymbol(
  report: InternalRewiringReport,
  symbolId: string
): InternalRewiringScenario[] {
  return report.scenarios.filter((scenario) =>
    scenario.subject.symbolIds?.includes(symbolId)
  );
}

export function getScenariosForModule(
  report: InternalRewiringReport,
  module: string
): InternalRewiringScenario[] {
  return report.scenarios.filter(
    (scenario) =>
      scenario.subject.module === module ||
      scenario.subject.edges?.some(
        (edge) => edge.source === module || edge.target === module
      )
  );
}

export function getScenariosForResponsibility(
  report: InternalRewiringReport,
  responsibility: string
): InternalRewiringScenario[] {
  return report.scenarios.filter(
    (scenario) =>
      scenario.current.responsibility === responsibility ||
      scenario.proposed.responsibility === responsibility ||
      scenario.subject.relationship?.from === responsibility ||
      scenario.subject.relationship?.to === responsibility ||
      scenario.effects.responsibilityBoundaries.responsibilitiesTouched.includes(
        responsibility
      )
  );
}

export function getScenariosByKind(
  report: InternalRewiringReport,
  kind: InternalRewiringScenarioKind
): InternalRewiringScenario[] {
  return report.scenarios.filter((scenario) => scenario.kind === kind);
}

export function getCompositionEvidence(
  report: InternalRewiringReport,
  module: string
): CompositionEvidence | undefined {
  return report.composition.find((entry) => entry.module === module);
}
interface MoveSimulation {
  closure: SymbolMovementClosure;
  edges: { source: string; target: string; symbolIds: string[] }[];
  effects: InternalRewiringEffects;
}
