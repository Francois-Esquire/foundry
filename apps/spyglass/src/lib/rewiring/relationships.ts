import type { ResponsibilityRelationship } from "../internal-responsibility-types";
import type {
  CurrentArrangement,
  InternalRewiringScenario,
  ProposedArrangement,
  ScenarioProvenance,
  ScenarioSubject,
  TargetEvidence,
} from "../internal-rewiring-types";
import type { ArchitecturalRoleFinding } from "../primitive-convention-types";
import {
  CONTRACT_FAMILY,
  roleCounts,
  same,
  scenarioId,
  sorted,
} from "./common";
import type { ScenarioCollection } from "./construction";
import type { RewiringFacts } from "./facts";
import type { MovementAnalysis } from "./movement";
export function collectRelationships(
  facts: RewiringFacts,
  movement: MovementAnalysis,
  collection: ScenarioCollection
): void {
  // Responsibility relationships: surfaces and contracts.
  const crossingSymbolsOf = (relationship: ResponsibilityRelationship) => {
    const ids = new Set<string>();
    for (const source of relationship.sourceModules) {
      for (const target of relationship.targetModules) {
        const edge = facts.edgeByKey.get(`${source}→${target}`);
        for (const symbol of edge?.symbols ?? []) {
          if (symbol.symbolId !== undefined) {
            ids.add(symbol.symbolId);
          }
        }
      }
    }
    return sorted(ids);
  };
  for (const relationship of [...facts.responsibilities.relationships].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
  )) {
    collectRelationshipCandidates(
      relationship,
      crossingSymbolsOf,
      facts,
      movement,
      collection
    );
  }
}
function collectRelationshipCandidates(
  relationship: ResponsibilityRelationship,
  crossingSymbolsOf: (relationship: ResponsibilityRelationship) => string[],
  index: Pick<
    RewiringFacts,
    | "findingById"
    | "edgeByKey"
    | "moduleFinding"
    | "regionById"
    | "policy"
    | "responsibilities"
    | "primaryModules"
    | "packagePublic"
  >,
  movement: Pick<
    MovementAnalysis,
    "provenanceOf" | "dominantRole" | "alignmentOf"
  >,
  collection: Pick<
    ScenarioCollection,
    "preserveCurrent" | "push" | "candidate" | "eligible" | "ineligible"
  >
) {
  const subject: ScenarioSubject = {
    key: `${relationship.from}→${relationship.to}`,
    kind: "responsibility-relationship",
    relationship: { from: relationship.from, to: relationship.to },
  };
  const crossing = crossingSymbolsOf(relationship)
    .map((id) => index.findingById.get(id))
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
      .filter((target) => index.edgeByKey.has(`${source}→${target}`))
      .map((target) => ({ source, target }))
  );
  const targetCandidates = (): ProposedArrangement["candidateModules"] => {
    const found: ProposedArrangement["candidateModules"] = [];
    const visitModule = (module: string) => {
      const finding = index.moduleFinding.get(module);
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
    for (const module of index.regionById.get(relationship.to)?.modules ?? []) {
      visitModule(module);
    }
    return found
      .sort(
        (a, b) =>
          b.evidence.length - a.evidence.length ||
          a.module.localeCompare(b.module)
      )
      .slice(0, index.policy.candidateModules);
  };
  let baseline: InternalRewiringScenario | undefined;
  const ensureBaseline = (scenarioProvenance: ScenarioProvenance) => {
    if (baseline !== undefined) {
      return;
    }
    baseline = collection.preserveCurrent(
      subject,
      current,
      crossing,
      undefined,
      ["symbol-identity", "responsibility-ownership"],
      scenarioProvenance
    );
    collection.push(baseline);
  };
  const provenance = movement.provenanceOf(
    crossing,
    sorted([...relationship.sourceModules, ...relationship.targetModules]),
    edges,
    [relationship.from, relationship.to, subject.key],
    []
  );
  // Surface.
  collectResponsibilitySurfaces(
    relationship,
    targetCandidates,
    ensureBaseline,
    provenance,
    subject,
    current,
    crossing,
    index,
    collection
  );
  // Contract beside implementation.
  const beside = crossing.filter(
    (f) =>
      CONTRACT_FAMILY.includes(f.primaryRole) &&
      f.placement.colocation === "with-behavior" &&
      f.declaration.responsibility === relationship.to
  );
  if (beside.length > 0) {
    const enough = beside.length >= index.policy.contract.minimumSymbols;
    const candidatesFound = targetCandidates().filter((c) =>
      c.evidence.includes("dedicated-role-module")
    );
    const contractSubject: ScenarioSubject = {
      ...subject,
      key: `${subject.key}|contract`,
    };
    if (enough) {
      const contractProvenance = movement.provenanceOf(
        beside,
        sorted(beside.map((f) => f.declaration.module)),
        edges.filter((e) =>
          beside.some((f) => f.declaration.module === e.target)
        ),
        [relationship.from, relationship.to, subject.key],
        []
      );
      collection.push(
        collection.preserveCurrent(
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
        (index.edgeByKey.get(`${e.source}→${e.target}`)?.symbols ?? []).some(
          (s) =>
            s.symbolId !== undefined &&
            beside.some((f) => f.symbolId === s.symbolId)
        )
      );
      collection.candidate(
        "contract-beside-implementation",
        "formalize-cross-responsibility-contract",
        contractSubject,
        collection.eligible([
          `${beside.length} contract-family symbols of ${relationship.to} consumed by ${relationship.from}`,
          `declared in ${new Set(beside.map((f) => f.declaration.module)).size} modules that also export behavior`,
        ]),
        {
          current: { ...current, roles: roleCounts(beside) },
          effects: {
            conventions: (() => {
              const role = movement.dominantRole(beside);
              const alignment = movement.alignmentOf(
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
                  index.primaryModules.length +
                  (candidatesFound.length === 0 ? 1 : 0),
                before: index.primaryModules.length,
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
            ...(beside.some((f) => index.packagePublic.has(f.symbolId))
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
      collection.candidate(
        "contract-beside-implementation",
        "formalize-cross-responsibility-contract",
        contractSubject,
        collection.ineligible(
          [`${beside.length} contract-family symbol declared beside behavior`],
          [`${index.policy.contract.minimumSymbols}+ such symbols`]
        )
      );
    }
  }
}
function collectResponsibilitySurfaces(
  relationship: ResponsibilityRelationship,
  targetCandidates: () => ProposedArrangement["candidateModules"],
  ensureBaseline: (scenarioProvenance: ScenarioProvenance) => void,
  provenance: ScenarioProvenance,
  subject: ScenarioSubject,
  current: CurrentArrangement,
  crossing: ArchitecturalRoleFinding[],
  index: Pick<RewiringFacts, "policy" | "responsibilities" | "primaryModules">,
  collection: Pick<ScenarioCollection, "candidate" | "eligible" | "ineligible">
) {
  if (relationship.targetModules.length >= 2) {
    const deep =
      relationship.targetModules.length >=
      index.policy.surface.minimumTargetModules;
    const enough =
      relationship.symbolFlow >= index.policy.surface.minimumSymbols;
    const candidatesFound = targetCandidates();
    recordResponsibilitySurface(
      deep,
      enough,
      ensureBaseline,
      provenance,
      subject,
      relationship,
      current,
      crossing,
      candidatesFound,
      index,
      collection
    );
  }
}
function recordResponsibilitySurface(
  deep: boolean,
  enough: boolean,
  ensureBaseline: (scenarioProvenance: ScenarioProvenance) => void,
  provenance: ScenarioProvenance,
  subject: ScenarioSubject,
  relationship: ResponsibilityRelationship,
  current: CurrentArrangement,
  crossing: ArchitecturalRoleFinding[],
  candidatesFound: {
    module: string;
    evidence: TargetEvidence[];
  }[],
  index: Pick<RewiringFacts, "responsibilities" | "primaryModules" | "policy">,
  collection: Pick<ScenarioCollection, "candidate" | "eligible" | "ineligible">
) {
  if (deep && enough) {
    ensureBaseline(provenance);
    collection.candidate(
      "deep-responsibility-dependency",
      "formalize-responsibility-surface",
      subject,
      collection.eligible([
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
            outcome: index.responsibilities.regionCycles.some(
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
                index.primaryModules.length +
                (candidatesFound.length === 0 ? 1 : 0),
              before: index.primaryModules.length,
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
    collection.candidate(
      "deep-responsibility-dependency",
      "formalize-responsibility-surface",
      subject,
      collection.ineligible(
        [
          `${relationship.targetModules.length} target modules, ${relationship.symbolFlow} symbols`,
        ],
        [
          ...(deep
            ? []
            : [`${index.policy.surface.minimumTargetModules}+ target modules`]),
          ...(enough
            ? []
            : [`${index.policy.surface.minimumSymbols}+ crossing symbols`]),
        ]
      )
    );
  }
}
