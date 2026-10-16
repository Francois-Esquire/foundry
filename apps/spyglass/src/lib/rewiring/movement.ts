import type {
  ClosureRelationship,
  ClosureSize,
  ConventionAlignment,
  InternalRewiringEffects,
  LocalityRelation,
  ProposedArrangement,
  ScenarioProvenance,
  ScenarioUncertainty,
  SymbolMovementClosure,
  TargetEvidence,
} from "../internal-rewiring-types";
import type { InternalModuleNode } from "../internal-topology-types";
import type {
  ArchitecturalRole,
  ArchitecturalRoleFinding,
  ArchitecturalScopeClass,
  ConventionDimension,
  PrimitiveConventionReport,
  PrimitiveModuleFinding,
} from "../primitive-convention-types";
import {
  EXECUTABLE_ROLES,
  HOSTABLE_ROLES,
  type MoveSimulation,
  RELATIONSHIP_KINDS,
  roleGroups,
  same,
  sorted,
} from "./common";
import type { RewiringFacts } from "./facts";
import { simulateSymbolMove } from "./simulate-move";
export function createMovementAnalysis(facts: RewiringFacts) {
  // Movement closure over declaration-level facts.
  const localDependencies = (
    symbolId: string
  ): {
    symbolId: string;
    relationship: ClosureRelationship;
  }[] => {
    const declaration = facts.declarationById.get(symbolId);
    const finding = facts.findingById.get(symbolId);
    if (declaration === undefined || finding === undefined) {
      return [];
    }
    const { module } = finding.declaration;
    const inModule = (id: string) =>
      facts.findingById.get(id)?.declaration.module === module &&
      id !== symbolId;
    const deps: {
      symbolId: string;
      relationship: ClosureRelationship;
    }[] = [];
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
    const all = facts.findingsByModule.get(module) ?? [];
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
    traverseMovementDependencies(
      queue,
      visited,
      dependsOn,
      moving,
      facts.findingById,
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
      pulled / all.length >= facts.policy.closure.largeShare
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
  ): {
    alignment: ConventionAlignment;
    ids: string[];
  } => {
    const group = facts.conventionGroup(role, scope, dimension);
    if (group === undefined || group.status === "insufficient-evidence") {
      return { alignment: "no-applicable-convention", ids: [] };
    }
    if (group.status === "competing") {
      return { alignment: "competing-convention", ids: group.conventions };
    }
    const id = group.conventions[0] ?? "";
    const value = facts.conventionById.get(id)?.value ?? "";
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
    (facts.regionById.get(region)?.modules ?? [])
      .map((m) => facts.moduleFinding.get(m))
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
        facts.primitives,
        facts.findingsByModule,
        scope,
        roles,
        add
      );
    } else {
      const members = facts.regionById.get(region)?.modules ?? [];
      if (members.length === 1 && members[0] !== undefined) {
        add(members[0], "only-module-in-responsibility");
      }
      for (const module of dedicatedModulesIn(region, roles)) {
        add(module.module, "dedicated-role-module");
        add(module.module, "same-responsibility");
        const convention = facts.conventionGroup(
          module.composition.dominantRole?.role ?? "unknown",
          scope,
          "module"
        );
        if (
          convention?.status === "convention" &&
          facts.conventionById.get(convention.conventions[0] ?? "")?.value ===
            "dedicated-role-module"
        ) {
          add(module.module, "matching-convention");
        }
      }
      const visitFinding = (currentMembers: string[]) => {
        for (const finding of group) {
          for (const concept of facts.declarationById.get(finding.symbolId)
            ?.concepts ?? []) {
            const declaring = facts.findingById.get(concept.conceptId)
              ?.declaration.module;
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
      .slice(0, facts.policy.candidateModules);
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
    simulateSymbolMove(
      group,
      module,
      targetModule,
      targetRegion,
      conventions,
      after,
      before,
      facts,
      { closureOf }
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
    const node =
      module === undefined ? undefined : facts.moduleNode.get(module);
    const finding =
      module === undefined ? undefined : facts.moduleFinding.get(module);
    const exported = (
      module === undefined ? [] : (facts.findingsByModule.get(module) ?? [])
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
        modules: same(facts.primaryModules.length),
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
    const publicOnes = group.filter((f) => facts.packagePublic.has(f.symbolId));
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
    const composition = facts.compositionByModule.get(module);
    if (composition?.roles.includes("unclear")) {
      out.push({
        detail: `${module} is wide-dependent without wiring evidence`,
        reason: "composition-role-unclear",
      });
    }
    assessRemainingCode(
      movement,
      group,
      facts.findingsByModule,
      module,
      out,
      closure,
      facts.moduleNode,
      facts.isRoot,
      targetKnown
    );
    return out;
  };
  const provenanceOf = (
    group: ArchitecturalRoleFinding[],
    modules: string[],
    edges: {
      source: string;
      target: string;
    }[],
    regions: (string | undefined)[],
    conventionIds: string[]
  ): ScenarioProvenance => ({
    locality: sorted(
      group
        .filter((f) => facts.localityById.has(f.symbolId))
        .map((f) => f.symbolId)
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
        const cycle = facts.moduleNode.get(m)?.cycle;
        return cycle === undefined ? [] : [cycle];
      }),
    ]),
  });
  return {
    alignmentOf,
    candidateModulesFor,
    closureOf,
    dedicatedModulesIn,
    dominantRole,
    localDependencies,
    localityOf,
    noEffects,
    provenanceOf,
    simulateMove,
    symbolUncertainties,
  };
}
export type MovementAnalysis = ReturnType<typeof createMovementAnalysis>;
function traverseMovementDependencies(
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
    classifyMovementDependencies(
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
function classifyMovementDependencies(
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
function assessRemainingCode(
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
