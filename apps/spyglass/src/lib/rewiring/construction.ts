import type {
  CandidateSource,
  CurrentArrangement,
  InternalRewiringScenario,
  InternalRewiringScenarioKind,
  RewiringPreservation,
  ScenarioCandidate,
  ScenarioEligibility,
  ScenarioProvenance,
  ScenarioSubject,
} from "../internal-rewiring-types";
import type {
  ArchitecturalRoleFinding,
  ArchitecturalScopeClass,
  PlacementConvention,
} from "../primitive-convention-types";
import type { DeclarationPlacement } from "../symbol-locality-types";
import {
  increment,
  roleCounts,
  scenarioId,
  sorted,
  sortedPartial,
  subjectIds,
} from "./common";
import type { RewiringFacts } from "./facts";
import type { MovementAnalysis } from "./movement";
export function createScenarioCollection(
  facts: RewiringFacts,
  movement: MovementAnalysis
) {
  // Symbol groups: by declaring module and target.
  const grouped = new Map<
    string,
    {
      module: string;
      target: string;
      members: ArchitecturalRoleFinding[];
    }
  >();
  // Modules: splits, composition roots, indirection.
  const roleSplitModules = new Set<string>();
  // Scenario construction.
  const scenarios: InternalRewiringScenario[] = [];
  const candidates: ScenarioCandidate[] = [];
  const familyByKey = new Map<
    string,
    {
      subject: ScenarioSubject;
      ids: string[];
    }
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
    const evidence = facts.moduleEvidence.get(module);
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
          (facts.consumersOf.get(f.symbolId) ?? []).map((c) => c.module)
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
      ...(first !== undefined && { locality: movement.localityOf(first) }),
      ...(facts.isRoot(module) && {
        compositionRoles: facts.compositionByModule.get(module)?.roles ?? [],
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
        (facts.consumersOf.get(f.symbolId) ?? []).map((c) => c.module)
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
      `declaring module ${first.declaration.status}${first.declaration.responsibility === undefined ? "" : ` in ${first.declaration.responsibility}`}${facts.ambiguityOf.has(first.declaration.module) ? ` (${facts.ambiguityOf.get(first.declaration.module) ?? ""})` : ""}`,
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
    effects: movement.noEffects(
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
    const group = facts.conventionGroup(convention.role, scope, "module");
    if (group?.status !== "convention") {
      return;
    }
    const strong =
      convention.support.symbols >=
      facts.policy.alignment.minimumSupportRatio *
        convention.exceptions.symbols;
    const byModule = new Map<string, ArchitecturalRoleFinding[]>();
    for (const id of convention.exceptions.symbolIds) {
      const finding = facts.findingById.get(id);
      if (finding === undefined) {
        continue;
      }
      const list = byModule.get(finding.declaration.module) ?? [];
      list.push(finding);
      byModule.set(finding.declaration.module, list);
    }
    collectConventionAlignments(
      byModule,
      convention,
      scope,
      strong,
      facts,
      movement,
      {
        candidate,
        currentOfGroup,
        eligible,
        factsOfGroup,
        ineligible,
        preserveCurrent,
        push,
        roleSplitModules,
      }
    );
  };
  return {
    candidate,
    candidates,
    currentOfGroup,
    eligible,
    factsOfGroup,
    familyByKey,
    grouped,
    ineligible,
    preserveCurrent,
    push,
    roleSplitModules,
    scenarios,
    visitConvention,
    visitFinding3,
  };
}
export type ScenarioCollection = ReturnType<typeof createScenarioCollection>;
function collectConventionAlignments(
  byModule: Map<string, ArchitecturalRoleFinding[]>,
  convention: PlacementConvention,
  scope: ArchitecturalScopeClass,
  strong: boolean,
  index: Pick<
    RewiringFacts,
    | "regionOf"
    | "policy"
    | "consumersOf"
    | "findingsByModule"
    | "primaryModules"
    | "packagePublic"
  >,
  movement: Pick<
    MovementAnalysis,
    | "candidateModulesFor"
    | "provenanceOf"
    | "closureOf"
    | "noEffects"
    | "localityOf"
    | "symbolUncertainties"
  >,
  collection: Pick<
    ScenarioCollection,
    | "currentOfGroup"
    | "candidate"
    | "ineligible"
    | "roleSplitModules"
    | "push"
    | "preserveCurrent"
    | "eligible"
    | "factsOfGroup"
  >
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
    const declaringRegion = index.regionOf(module);
    const targetRegion =
      scope === "responsibility-local"
        ? first.served?.responsibility
        : undefined;
    const targets = movement.candidateModulesFor(members, targetRegion, scope);
    const current = collection.currentOfGroup(members, module);
    const provenance = movement.provenanceOf(
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
      collection.candidate(
        "convention-outlier",
        "align-with-convention",
        subject,
        collection.ineligible(reasons, [
          `support at least ${index.policy.alignment.minimumSupportRatio}× exceptions`,
        ])
      );
      continue;
    }
    if (collection.roleSplitModules.has(module)) {
      collection.candidate(
        "convention-outlier",
        "align-with-convention",
        subject,
        collection.ineligible(reasons, [
          "a module not already covered by a split-by-role scenario",
        ])
      );
      continue;
    }
    const carrying = new Set(
      members.flatMap((f) =>
        (index.consumersOf.get(f.symbolId) ?? []).map(
          (c) => `${c.module}→${c.via ?? module}`
        )
      )
    );
    const exported = (index.findingsByModule.get(module) ?? []).filter(
      (f) => f.exported && f.primaryRole !== "unknown"
    );
    const ids = new Set(members.map((f) => f.symbolId));
    const rolesBefore = new Set(exported.map((f) => f.primaryRole)).size;
    const rolesAfter = new Set(
      exported.filter((f) => !ids.has(f.symbolId)).map((f) => f.primaryRole)
    ).size;
    const closure = movement.closureOf([...ids], module);
    const base = movement.noEffects(
      module,
      members.length,
      movement.localityOf(first),
      {
        alignment: "matches-convention",
        conventionIds: [convention.id],
      }
    );
    collection.push(
      collection.preserveCurrent(
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
    collection.candidate(
      "convention-outlier",
      "align-with-convention",
      subject,
      collection.eligible([
        ...reasons,
        `placed in a mixed-role module: ${module}`,
      ]),
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
              after:
                index.primaryModules.length + (targets.length === 0 ? 1 : 0),
              before: index.primaryModules.length,
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
          ...(members.some((f) => index.packagePublic.has(f.symbolId))
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
            ...collection.factsOfGroup(members),
            `${convention.support.symbols} comparable symbols sit in dedicated ${convention.role} modules; these ${members.length} sit beside other roles`,
          ],
          sources: ["convention-outlier"],
        },
        subject,
        uncertainties: movement.symbolUncertainties(
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
