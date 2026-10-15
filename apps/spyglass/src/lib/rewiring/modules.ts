import type { ResponsibilityModuleEvidence } from "../internal-responsibility-types";
import type {
  CompositionEvidence,
  CurrentArrangement,
  InternalRewiringScenario,
  RewiringPreservation,
  RoleGroup,
  ScenarioProvenance,
  ScenarioSubject,
  ScopeGroup,
} from "../internal-rewiring-types";
import type { InternalModuleNode } from "../internal-topology-types";
import type {
  ArchitecturalRoleFinding,
  PrimitiveModuleFinding,
} from "../primitive-convention-types";
import {
  roleCounts,
  roleGroups,
  STRUCTURAL_ROLES,
  same,
  scenarioId,
  scopeGroups,
  sorted,
  WIRING_ROLES,
} from "./common";
import type { ScenarioCollection } from "./construction";
import type { RewiringFacts } from "./facts";
import type { MovementAnalysis } from "./movement";
import { collectRoleSplits } from "./role-scenarios";
import { simulateResponsibilitySplit } from "./split-module";
export function collectModules(
  facts: RewiringFacts,
  movement: MovementAnalysis,
  collection: ScenarioCollection
): void {
  for (const finding of facts.primitives.modules) {
    collectModuleCandidates(finding, facts, movement, collection);
  }
}
function collectModuleCandidates(
  finding: PrimitiveModuleFinding,
  index: Pick<
    RewiringFacts,
    | "findingsByModule"
    | "regionOf"
    | "compositionByModule"
    | "moduleNode"
    | "isRoot"
    | "policy"
    | "findingById"
    | "edgeByKey"
    | "primaryModules"
    | "conventionGroup"
    | "conventionById"
    | "edgesByTarget"
    | "edgesBySource"
    | "moduleEvidence"
    | "classifyEdge"
    | "reaches"
    | "packagePublic"
  >,
  movement: Pick<
    MovementAnalysis,
    | "provenanceOf"
    | "candidateModulesFor"
    | "dominantRole"
    | "alignmentOf"
    | "simulateMove"
    | "localityOf"
    | "closureOf"
    | "localDependencies"
    | "symbolUncertainties"
    | "noEffects"
  >,
  collection: Pick<
    ScenarioCollection,
    | "preserveCurrent"
    | "push"
    | "candidate"
    | "ineligible"
    | "eligible"
    | "roleSplitModules"
  >
) {
  const { module } = finding;
  const all = index.findingsByModule.get(module) ?? [];
  const exported = all.filter((f) => f.exported);
  const subject: ScenarioSubject = { key: module, kind: "module", module };
  const region = index.regionOf(module);
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
    ...(index.compositionByModule.has(module) && {
      compositionRoles: index.compositionByModule.get(module)?.roles ?? [],
    }),
  };
  const node = index.moduleNode.get(module);
  let baseline: InternalRewiringScenario | undefined;
  const ensureBaseline = (provenance: ScenarioProvenance) => {
    if (baseline !== undefined) {
      return;
    }
    baseline = collection.preserveCurrent(
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
        ...(index.isRoot(module)
          ? (["composition-role"] as RewiringPreservation[])
          : []),
      ],
      provenance
    );
    collection.push(baseline);
  };
  const moduleProvenance = (
    group: ArchitecturalRoleFinding[],
    edges: {
      source: string;
      target: string;
    }[],
    regions: (string | undefined)[],
    conventionIds: string[]
  ) =>
    movement.provenanceOf(
      group,
      [module],
      edges,
      [region, ...regions],
      conventionIds
    );
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
      (g) => g.symbolIds.length >= index.policy.split.minimumGroupSymbols
    );
    const remainderOf = (separated: ScopeGroup[]) =>
      groups.filter((g) => !separated.includes(g));
    const splitScenario = (
      separated: ScopeGroup[],
      variant: "partial" | "full"
    ): InternalRewiringScenario =>
      simulateResponsibilitySplit(
        separated,
        remainderOf,
        module,
        node,
        finding,
        exported,
        roleList,
        scoped,
        variant,
        current,
        moduleProvenance,
        localGroups,
        subject,
        index,
        movement
      );
    if (qualifying.length === 0) {
      collection.candidate(
        "mixed-scope",
        "split-module-by-responsibility",
        subject,
        collection.ineligible(
          [
            `${localGroups.length} responsibility-local groups, largest ${localGroups[0]?.symbolIds.length ?? 0} symbols`,
          ],
          [
            `a responsibility-local group of ${index.policy.split.minimumGroupSymbols}+ symbols`,
          ]
        )
      );
    } else {
      const [strongest] = qualifying;
      if (strongest !== undefined) {
        const partial = splitScenario([strongest], "partial");
        ensureBaseline(partial.provenance);
        collection.candidate(
          "mixed-scope",
          "split-module-by-responsibility",
          subject,
          collection.eligible([
            `mixed-scope: ${groups.length} scope groups`,
            `${qualifying.length} responsibility-local groups at or above ${index.policy.split.minimumGroupSymbols} symbols`,
          ]),
          partial
        );
        if (qualifying.length > 1) {
          collection.push(splitScenario(qualifying, "full"));
        }
      }
    }
  }
  // Split by role.
  collectRoleSplits(
    finding,
    groups,
    roleList,
    module,
    moduleProvenance,
    ensureBaseline,
    subject,
    current,
    node,
    region,
    exported,
    index,
    movement,
    collection
  );
  // Composition root.
  const composition = index.compositionByModule.get(module);
  collectCompositionPreservations(
    composition,
    exported,
    moduleProvenance,
    ensureBaseline,
    subject,
    current,
    module,
    node,
    region,
    index,
    movement,
    collection
  );
  // Indirection.
  const thin =
    node?.fanIn === 1 && node.fanOut >= 1 && node.cycle === undefined;
  const consumerOfThin =
    (index.edgesByTarget.get(module) ?? [])[0]?.source ?? "";
  collectIndirectionCandidates(
    thin,
    composition,
    consumerOfThin,
    module,
    node,
    all,
    subject,
    region,
    ensureBaseline,
    current,
    roleList,
    groups,
    index,
    movement,
    collection
  );
}
function collectIndirectionCandidates(
  thin: boolean,
  composition: CompositionEvidence | undefined,
  consumerOfThin: string,
  module: string,
  node: InternalModuleNode | undefined,
  all: ArchitecturalRoleFinding[],
  subject: ScenarioSubject,
  region: string | undefined,
  ensureBaseline: (provenance: ScenarioProvenance) => void,
  current: CurrentArrangement,
  roleList: RoleGroup[],
  groups: ScopeGroup[],
  index: Pick<
    RewiringFacts,
    | "compositionByModule"
    | "edgesBySource"
    | "moduleEvidence"
    | "policy"
    | "classifyEdge"
    | "edgeByKey"
    | "moduleNode"
    | "reaches"
    | "regionOf"
    | "primaryModules"
    | "packagePublic"
  >,
  movement: Pick<MovementAnalysis, "provenanceOf">,
  collection: Pick<ScenarioCollection, "candidate" | "ineligible" | "eligible">
) {
  if (node === undefined) {
    return;
  }
  if (
    thin &&
    composition?.roles.includes("aggregation") !== true &&
    index.compositionByModule
      .get(consumerOfThin)
      ?.roles.includes("aggregation") !== true
  ) {
    const consumer = consumerOfThin;
    const providers = sorted(
      (index.edgesBySource.get(module) ?? []).map((e) => e.target)
    );
    const evidence = index.moduleEvidence.get(module);
    const reasons: string[] = [];
    const missing: string[] = [];
    if (providers.length > index.policy.indirection.maximumProviders) {
      missing.push(
        `at most ${index.policy.indirection.maximumProviders} providers (has ${providers.length})`
      );
    }
    if (
      node.exportedSymbols > index.policy.indirection.maximumExportedSymbols
    ) {
      missing.push(
        `at most ${index.policy.indirection.maximumExportedSymbols} exported symbols (has ${node.exportedSymbols})`
      );
    }
    if (
      (evidence?.behaviorMass ?? 0) > index.policy.indirection.maximumStatements
    ) {
      missing.push(
        `at most ${index.policy.indirection.maximumStatements} statements (has ${evidence?.behaviorMass ?? 0})`
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
    recordIneligibleIndirection(
      missing,
      node,
      subject,
      reasons,
      consumer,
      module,
      providers,
      all,
      region,
      ensureBaseline,
      current,
      roleList,
      groups,
      evidence,
      index,
      movement,
      collection
    );
  }
}
function recordIneligibleIndirection(
  missing: string[],
  node: InternalModuleNode,
  subject: ScenarioSubject,
  reasons: string[],
  consumer: string,
  module: string,
  providers: string[],
  all: ArchitecturalRoleFinding[],
  region: string | undefined,
  ensureBaseline: (provenance: ScenarioProvenance) => void,
  current: CurrentArrangement,
  roleList: RoleGroup[],
  groups: ScopeGroup[],
  evidence: ResponsibilityModuleEvidence | undefined,
  index: Pick<
    RewiringFacts,
    | "policy"
    | "classifyEdge"
    | "edgeByKey"
    | "moduleNode"
    | "reaches"
    | "regionOf"
    | "primaryModules"
    | "packagePublic"
  >,
  movement: Pick<MovementAnalysis, "provenanceOf">,
  collection: Pick<ScenarioCollection, "candidate" | "ineligible" | "eligible">
) {
  if (
    missing.length > 0 &&
    node.exportedSymbols <= index.policy.indirection.maximumExportedSymbols
  ) {
    collection.candidate(
      "indirection",
      "collapse-indirection",
      subject,
      collection.ineligible(reasons, missing)
    );
  } else if (missing.length === 0) {
    const before = {
      cross: 0,
      unresolved: 0,
      within: 0,
    };
    const after = { cross: 0, unresolved: 0, within: 0 };
    before[index.classifyEdge(consumer, module)] += 1;
    const visitProvider = (provider: string) => {
      before[index.classifyEdge(module, provider)] += 1;
      if (index.edgeByKey.has(`${consumer}→${provider}`)) {
        return;
      }
      after[index.classifyEdge(consumer, provider)] += 1;
    };
    for (const provider of providers) {
      visitProvider(provider);
    }
    const added = providers.filter(
      (p) => !index.edgeByKey.has(`${consumer}→${p}`)
    ).length;
    const consumerNode = index.moduleNode.get(consumer);
    const potential = providers.some((p) =>
      index.reaches(p, (m) => m === consumer)
    );
    const provenance = movement.provenanceOf(
      all,
      [module, consumer, ...providers],
      [
        { source: consumer, target: module },
        ...providers.map((p) => ({ source: module, target: p })),
      ],
      [region, index.regionOf(consumer), ...providers.map(index.regionOf)],
      []
    );
    ensureBaseline(provenance);
    collection.candidate(
      "indirection",
      "collapse-indirection",
      subject,
      collection.eligible(reasons),
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
              after: index.primaryModules.length - 1,
              before: index.primaryModules.length,
            },
            roleGroups: { after: 0, before: roleList.length },
            scopeGroups: { after: 0, before: groups.length },
          },
          responsibilityBoundaries: {
            crossEdges: { after: after.cross, before: before.cross },
            crossingSymbols: same(0),
            responsibilitiesTouched: sorted(
              [
                region,
                index.regionOf(consumer),
                ...providers.map(index.regionOf),
              ].filter((r): r is string => r !== undefined)
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
          ...(index.regionOf(consumer) !== undefined && {
            responsibility: index.regionOf(consumer),
          }),
          candidateModules:
            region !== undefined && index.regionOf(consumer) === region
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
          ...(all.some((f) => index.packagePublic.has(f.symbolId))
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
function collectCompositionPreservations(
  composition: CompositionEvidence | undefined,
  exported: ArchitecturalRoleFinding[],
  moduleProvenance: (
    group: ArchitecturalRoleFinding[],
    edges: {
      source: string;
      target: string;
    }[],
    regions: (string | undefined)[],
    conventionIds: string[]
  ) => ScenarioProvenance,
  ensureBaseline: (provenance: ScenarioProvenance) => void,
  subject: ScenarioSubject,
  current: CurrentArrangement,
  module: string,
  node: InternalModuleNode | undefined,
  region: string | undefined,
  index: Pick<RewiringFacts, "policy">,
  movement: Pick<MovementAnalysis, "noEffects">,
  collection: Pick<ScenarioCollection, "candidate" | "eligible" | "ineligible">
) {
  if (composition !== undefined) {
    recordCompositionPreservation(
      composition,
      exported,
      moduleProvenance,
      ensureBaseline,
      subject,
      current,
      module,
      node,
      region,
      index,
      movement,
      collection
    );
  }
}
function recordCompositionPreservation(
  composition: CompositionEvidence,
  exported: ArchitecturalRoleFinding[],
  moduleProvenance: (
    group: ArchitecturalRoleFinding[],
    edges: {
      source: string;
      target: string;
    }[],
    regions: (string | undefined)[],
    conventionIds: string[]
  ) => ScenarioProvenance,
  ensureBaseline: (provenance: ScenarioProvenance) => void,
  subject: ScenarioSubject,
  current: CurrentArrangement,
  module: string,
  node: InternalModuleNode | undefined,
  region: string | undefined,
  index: Pick<RewiringFacts, "policy">,
  movement: Pick<MovementAnalysis, "noEffects">,
  collection: Pick<ScenarioCollection, "candidate" | "eligible" | "ineligible">
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
    collection.candidate(
      "composition-root",
      "preserve-composition-root",
      subject,
      collection.eligible(composition.evidence),
      {
        current,
        effects: movement.noEffects(module, exported.length, "not-applicable"),
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
      index.policy.compositionRoot.minimumResponsibilities
    ) {
      missing.push(
        `${index.policy.compositionRoot.minimumResponsibilities}+ responsibilities depended on`
      );
    }
    if (
      composition.exportedSymbols >
      index.policy.compositionRoot.maximumExportedSymbols
    ) {
      missing.push(
        `at most ${index.policy.compositionRoot.maximumExportedSymbols} exported symbols (has ${composition.exportedSymbols})`
      );
    }
    if (sites < index.policy.compositionRoot.minimumWiringSites) {
      missing.push(
        `${index.policy.compositionRoot.minimumWiringSites}+ wiring sites`
      );
    }
    if (
      composition.wiredResponsibilities.length <
      index.policy.compositionRoot.minimumWiredResponsibilities
    ) {
      missing.push(
        `wiring into ${index.policy.compositionRoot.minimumWiredResponsibilities}+ responsibilities`
      );
    }
    collection.candidate(
      "wide-dependent",
      "preserve-composition-root",
      subject,
      collection.ineligible(
        [
          `wide-dependent: ${composition.responsibilities.length} responsibilities, ${composition.exportedSymbols} exports, ${sites} wiring sites, roles ${composition.roles.join(", ")}`,
        ],
        missing
      )
    );
  }
}
