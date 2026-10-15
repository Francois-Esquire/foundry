import type {
  BeforeAfter,
  ConventionAlignment,
  CurrentArrangement,
  CycleOutcome,
  InternalRewiringEffects,
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
  type MoveSimulation,
  roleGroups,
  same,
  scenarioId,
  sorted,
  splitScenarioPattern,
  UNCERTAINTIES,
} from "./common";
import type { RewiringFacts } from "./facts";
import type { MovementAnalysis } from "./movement";
export function simulateResponsibilitySplit(
  separated: ScopeGroup[],
  remainderOf: (separated: ScopeGroup[]) => ScopeGroup[],
  module: string,
  node: InternalModuleNode | undefined,
  finding: PrimitiveModuleFinding,
  exported: ArchitecturalRoleFinding[],
  roleList: RoleGroup[],
  scoped: (g: ScopeGroup) => boolean,
  variant: "partial" | "full",
  current: CurrentArrangement,
  moduleProvenance: (
    group: ArchitecturalRoleFinding[],
    edges: {
      source: string;
      target: string;
    }[],
    regions: (string | undefined)[],
    conventionIds: string[]
  ) => ScenarioProvenance,
  localGroups: ScopeGroup[],
  subject: ScenarioSubject,
  index: Pick<
    RewiringFacts,
    "findingById" | "edgeByKey" | "primaryModules" | "isRoot"
  >,
  movement: Pick<
    MovementAnalysis,
    | "candidateModulesFor"
    | "dominantRole"
    | "alignmentOf"
    | "simulateMove"
    | "localityOf"
    | "closureOf"
    | "localDependencies"
    | "symbolUncertainties"
  >
): InternalRewiringScenario {
  const moving = separated
    .flatMap((g) => g.symbolIds.map((id) => index.findingById.get(id)))
    .filter((f): f is ArchitecturalRoleFinding => f !== undefined);
  const remainder = remainderOf(separated);
  // Effects: each group moves toward its responsibility; sum over groups.
  const simulations = separated.flatMap((g) => {
    const members = g.symbolIds
      .map((id) => index.findingById.get(id))
      .filter((f): f is ArchitecturalRoleFinding => f !== undefined);
    const [head] = members;
    if (head === undefined) {
      return [];
    }
    const targets =
      separated.length === 1
        ? movement.candidateModulesFor(
            members,
            g.responsibility,
            "responsibility-local"
          )
        : [];
    const role = movement.dominantRole(members);
    const directory = movement.alignmentOf(
      role,
      "responsibility-local",
      "directory",
      [
        "inside-responsibility",
        "responsibility-root",
        "dedicated-role-directory",
      ]
    );
    return [
      {
        group: g,
        simulation: movement.simulateMove(
          members,
          module,
          g.responsibility,
          targets.length === 1 ? targets[0]?.module : undefined,
          movement.localityOf(head),
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
  const closure = movement.closureOf(
    moving.map((f) => f.symbolId),
    module
  );
  const crossGroup = separated.some((a) =>
    a.symbolIds.some((id) =>
      movement
        .localDependencies(id)
        .some((dep) =>
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
  const outcome: CycleOutcome = combinedCycleOutcome(cycles);
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
                        index.edgeByKey
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
          index.primaryModules.length +
          simulations.filter((s) => s.targets.length === 0).length,
        before: index.primaryModules.length,
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
  const uncertainties = movement.symbolUncertainties(
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
      ...(index.isRoot(module)
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
function combinedCycleOutcome(
  cycles: {
    membership: string[];
    outcome: CycleOutcome;
    detail?: string;
  }[]
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
