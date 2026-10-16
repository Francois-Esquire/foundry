import type {
  CandidateSource,
  CurrentArrangement,
  InternalRewiringScenario,
  InternalRewiringScenarioKind,
  RewiringPreservation,
  ScenarioProvenance,
  ScenarioSubject,
  ScenarioUncertainty,
  SymbolMovementClosure,
  TargetEvidence,
} from "../internal-rewiring-types";
import type { ArchitecturalRoleFinding } from "../primitive-convention-types";
import {
  CONTRACT_FAMILY,
  contractPreservationEligibility,
  createContractPreservation,
  createPromotionScenario,
  type MoveSimulation,
  same,
  scenarioId,
  sorted,
  subjectIds,
} from "./common";
import type { ScenarioCollection } from "./construction";
import type { RewiringFacts } from "./facts";
import type { MovementAnalysis } from "./movement";
export function collectSymbols(
  facts: RewiringFacts,
  movement: MovementAnalysis,
  collection: ScenarioCollection
): void {
  for (const finding of facts.primitives.symbols) {
    collection.visitFinding3(finding);
  }
  collectSymbolPlacementCandidates(
    collection.grouped,
    facts,
    movement,
    collection
  );
}
function collectSymbolPlacementCandidates(
  grouped: Map<
    string,
    {
      module: string;
      target: string;
      members: ArchitecturalRoleFinding[];
    }
  >,
  index: Pick<
    RewiringFacts,
    "regionOf" | "packagePublic" | "isRoot" | "primaryModules" | "primitives"
  >,
  movement: Pick<
    MovementAnalysis,
    | "symbolUncertainties"
    | "candidateModulesFor"
    | "dominantRole"
    | "alignmentOf"
    | "simulateMove"
    | "localityOf"
    | "provenanceOf"
    | "noEffects"
  >,
  collection: Pick<
    ScenarioCollection,
    | "currentOfGroup"
    | "factsOfGroup"
    | "preserveCurrent"
    | "push"
    | "candidate"
    | "eligible"
    | "ineligible"
  >
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
    const current = collection.currentOfGroup(group, module);
    const facts = collection.factsOfGroup(group);
    const declaringRegion = index.regionOf(module);
    const basePreservations: RewiringPreservation[] = [
      "symbol-identity",
      ...(group.some((f) => index.packagePublic.has(f.symbolId))
        ? (["public-exposure"] as RewiringPreservation[])
        : []),
    ];
    const publicUncertainty = movement.symbolUncertainties(
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
      baseline = collection.preserveCurrent(
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
      collection.push(baseline);
    };
    if (first.scope === "responsibility-local") {
      collectLocalSymbolMoves(
        first,
        group,
        target,
        module,
        declaringRegion,
        ensureBaseline,
        current,
        subject,
        basePreservations,
        facts,
        publicUncertainty,
        index,
        movement,
        collection
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
      const provenance = movement.provenanceOf(
        group,
        [module],
        [],
        [declaringRegion],
        []
      );
      ensureBaseline(provenance);
      collection.candidate(
        source,
        "preserve-package-primitive",
        subject,
        collection.eligible([
          `package-wide: ${foreign.length} responsibilities consume the group`,
        ]),
        {
          current,
          effects: movement.noEffects(
            module,
            group.length,
            movement.localityOf(first),
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
              `serves ${new Set(group.flatMap((f) => f.consumers.responsibilities)).size} responsibilities, at or above the package-wide threshold of ${index.primitives.policy.packageWide.threshold}`,
            ],
            sources: [source],
          },
          subject,
          uncertainties: publicUncertainty,
        }
      );
    }
    collectSharedSymbolPreservations(
      scope,
      group,
      first,
      declaringRegion,
      subject,
      module,
      ensureBaseline,
      source,
      foreign,
      noConvention,
      basePreservations,
      movement,
      collection
    );
    collectSymbolPromotions(
      first,
      foreign,
      group,
      scope,
      module,
      declaringRegion,
      ensureBaseline,
      source,
      subject,
      current,
      basePreservations,
      facts,
      movement,
      collection
    );
  }
}
function collectLocalSymbolMoves(
  first: ArchitecturalRoleFinding,
  group: ArchitecturalRoleFinding[],
  target: string,
  module: string,
  declaringRegion: string | undefined,
  ensureBaseline: (provenance: ScenarioProvenance) => void,
  current: CurrentArrangement,
  subject: ScenarioSubject,
  basePreservations: RewiringPreservation[],
  facts: string[],
  publicUncertainty: ScenarioUncertainty[],
  index: Pick<RewiringFacts, "isRoot" | "primaryModules">,
  movement: Pick<
    MovementAnalysis,
    | "candidateModulesFor"
    | "dominantRole"
    | "alignmentOf"
    | "simulateMove"
    | "localityOf"
    | "provenanceOf"
    | "symbolUncertainties"
  >,
  collection: Pick<
    ScenarioCollection,
    "candidate" | "eligible" | "push" | "preserveCurrent"
  >
) {
  const { placed } = first.declaration;
  const kind: InternalRewiringScenarioKind = placed
    ? "demote-primitive"
    : "colocate-primitive";
  const source: CandidateSource = placed
    ? "declared-outside-served-responsibility"
    : "declared-in-unresolved-module";
  const targetModules = movement.candidateModulesFor(
    group,
    target,
    "responsibility-local"
  );
  const targetModule =
    targetModules.length === 1 ? targetModules[0]?.module : undefined;
  const role = movement.dominantRole(group);
  const directory = movement.alignmentOf(
    role,
    "responsibility-local",
    "directory",
    ["inside-responsibility", "responsibility-root", "dedicated-role-directory"]
  );
  const simulation = movement.simulateMove(
    group,
    module,
    target,
    targetModule,
    movement.localityOf(first),
    "declared-in-serving-responsibility",
    { alignment: directory.alignment, conventionIds: directory.ids }
  );
  const provenance = movement.provenanceOf(
    group,
    [module],
    simulation.edges,
    [declaringRegion, target],
    directory.ids
  );
  ensureBaseline(provenance);
  const scenario: InternalRewiringScenario = createLocalMovementScenario(
    simulation,
    current,
    kind,
    subject,
    target,
    basePreservations,
    index.isRoot,
    module,
    targetModules,
    provenance,
    facts,
    source,
    movement.symbolUncertainties,
    group
  );
  collection.candidate(
    source,
    kind,
    subject,
    collection.eligible([
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
    collection.push(
      collection.preserveCurrent(
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
          modules: same(index.primaryModules.length),
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
    collection.candidate(
      source,
      "redirect-internal-dependency",
      redirectSubject,
      collection.eligible([`${simulation.edges.length} consumer edges`]),
      redirect
    );
  }
}
function createLocalMovementScenario(
  simulation: MoveSimulation,
  current: CurrentArrangement,
  kind: InternalRewiringScenarioKind,
  subject: ScenarioSubject,
  target: string,
  basePreservations: RewiringPreservation[],
  isRoot: (module: string) => boolean,
  module: string,
  targetModules: {
    module: string;
    evidence: TargetEvidence[];
  }[],
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
function collectSharedSymbolPreservations(
  scope: "cross-responsibility" | "package-wide",
  group: ArchitecturalRoleFinding[],
  first: ArchitecturalRoleFinding,
  declaringRegion: string | undefined,
  subject: ScenarioSubject,
  module: string,
  ensureBaseline: (provenance: ScenarioProvenance) => void,
  source: "cross-responsibility" | "package-wide",
  foreign: string[],
  noConvention: {
    alignment: "no-applicable-convention";
    conventionIds: never[];
  },
  basePreservations: RewiringPreservation[],
  movement: Pick<
    MovementAnalysis,
    "provenanceOf" | "noEffects" | "localityOf" | "symbolUncertainties"
  >,
  collection: Pick<
    ScenarioCollection,
    "candidate" | "eligible" | "ineligible" | "currentOfGroup" | "factsOfGroup"
  >
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
      const provenance = movement.provenanceOf(
        contracts,
        [module],
        [],
        [declaringRegion],
        []
      );
      if (holds) {
        ensureBaseline(provenance);
      }
      collection.candidate(
        source,
        "preserve-cross-responsibility-contract",
        preserveSubject,
        contractPreservationEligibility(
          holds,
          collection.eligible,
          contracts,
          foreign,
          ownedByConsumer,
          first,
          dedicated,
          collection.ineligible
        ),
        createContractPreservation(
          holds,
          contracts,
          module,
          first,
          noConvention,
          preserveSubject,
          declaringRegion,
          basePreservations,
          provenance,
          source,
          movement,
          collection
        )
      );
    }
  }
}
function collectSymbolPromotions(
  first: ArchitecturalRoleFinding,
  foreign: string[],
  group: ArchitecturalRoleFinding[],
  scope: "cross-responsibility" | "package-wide",
  module: string,
  declaringRegion: string | undefined,
  ensureBaseline: (provenance: ScenarioProvenance) => void,
  source: "cross-responsibility" | "package-wide",
  subject: ScenarioSubject,
  current: CurrentArrangement,
  basePreservations: RewiringPreservation[],
  facts: string[],
  movement: Pick<
    MovementAnalysis,
    | "candidateModulesFor"
    | "dominantRole"
    | "alignmentOf"
    | "simulateMove"
    | "localityOf"
    | "provenanceOf"
    | "symbolUncertainties"
  >,
  collection: Pick<ScenarioCollection, "candidate" | "eligible" | "ineligible">
) {
  if (first.declaration.placed) {
    const promotable = foreign.length >= 2;
    const targetModules = movement.candidateModulesFor(group, undefined, scope);
    const role = movement.dominantRole(group);
    const directory = movement.alignmentOf(role, scope, "directory", [
      "package-root",
      "dedicated-role-directory",
    ]);
    let simulation: MoveSimulation | undefined;
    if (promotable) {
      simulation = movement.simulateMove(
        group,
        module,
        undefined,
        targetModules.length === 1 ? targetModules[0]?.module : undefined,
        movement.localityOf(first),
        "declared-at-shared-scope",
        { alignment: directory.alignment, conventionIds: directory.ids }
      );
    } else {
      simulation = undefined;
    }
    const provenance = movement.provenanceOf(
      group,
      [module],
      simulation?.edges ?? [],
      [declaringRegion, ...foreign],
      directory.ids
    );
    if (promotable) {
      ensureBaseline(provenance);
    }
    collection.candidate(
      source,
      "promote-primitive",
      subject,
      promotable
        ? collection.eligible([
            `${scope} scope declared inside ${declaringRegion ?? ""}`,
            `${foreign.length} other responsibilities consume the group`,
          ])
        : collection.ineligible(
            [
              "one other responsibility consumes the group: an ordinary dependency",
            ],
            ["a second consuming responsibility"]
          ),
      createPromotionScenario(
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
        movement.symbolUncertainties,
        module
      )
    );
  }
}
