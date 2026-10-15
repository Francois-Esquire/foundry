import type {
  CurrentArrangement,
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
import { same, scenarioId, sorted, UNCERTAINTIES } from "./common";
import type { ScenarioCollection } from "./construction";
import type { RewiringFacts } from "./facts";
import type { MovementAnalysis } from "./movement";
export function collectRoleSplits(
  finding: PrimitiveModuleFinding,
  groups: ScopeGroup[],
  roleList: RoleGroup[],
  module: string,
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
  node: InternalModuleNode | undefined,
  region: string | undefined,
  exported: ArchitecturalRoleFinding[],
  index: Pick<
    RewiringFacts,
    | "policy"
    | "conventionGroup"
    | "conventionById"
    | "findingById"
    | "primaryModules"
  >,
  movement: Pick<
    MovementAnalysis,
    "closureOf" | "localDependencies" | "symbolUncertainties" | "noEffects"
  >,
  collection: Pick<
    ScenarioCollection,
    "roleSplitModules" | "candidate" | "eligible" | "ineligible"
  >
) {
  if (
    finding.composition.roles === "mixed-role" &&
    finding.composition.scopes === "single-scope"
  ) {
    const scope = groups[0]?.scope ?? "unclear";
    const qualifying = roleList.filter(
      (g) => g.symbolIds.length >= index.policy.split.minimumGroupSymbols
    );
    const supporting = qualifying.filter((g) => {
      const convention = index.conventionGroup(g.role, scope, "module");
      return (
        convention !== undefined &&
        convention.status !== "insufficient-evidence" &&
        convention.conventions.some(
          (id) =>
            index.conventionById.get(id)?.value === "dedicated-role-module"
        )
      );
    });
    const ids = sorted(
      supporting.flatMap(
        (g) => index.conventionGroup(g.role, scope, "module")?.conventions ?? []
      )
    );
    if (qualifying.length >= 2 && supporting.length > 0) {
      const closure = movement.closureOf(
        qualifying.flatMap((g) => g.symbolIds),
        module
      );
      const crossGroup = qualifying.some((a) =>
        a.symbolIds.some((id) =>
          movement
            .localDependencies(id)
            .some((dep) =>
              qualifying.some(
                (b) => b !== a && b.symbolIds.includes(dep.symbolId)
              )
            )
        )
      );
      const moving = qualifying
        .flatMap((g) => g.symbolIds.map((id) => index.findingById.get(id)))
        .filter((f): f is ArchitecturalRoleFinding => f !== undefined);
      const provenance = moduleProvenance(
        moving,
        [],
        [groups[0]?.responsibility],
        ids
      );
      ensureBaseline(provenance);
      const uncertainties = movement
        .symbolUncertainties(moving, module, closure, true, false)
        .filter((u) => u.reason !== "target-module-unresolved");
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
      collection.roleSplitModules.add(module);
      collection.candidate(
        "mixed-role",
        "split-module-by-role",
        subject,
        collection.eligible([
          `mixed-role at one scope (${scope})`,
          `${qualifying.length} role groups at or above ${index.policy.split.minimumGroupSymbols} symbols`,
          `dedicated-role-module convention observed for ${supporting.map((g) => g.role).join(", ")}`,
        ]),
        {
          closure,
          current,
          effects: {
            ...movement.noEffects(module, moving.length, "not-applicable", {
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
                after: index.primaryModules.length + qualifying.length - 1,
                before: index.primaryModules.length,
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
      collection.candidate(
        "mixed-role",
        "split-module-by-role",
        subject,
        collection.ineligible(
          [
            `${qualifying.length} role groups, no dedicated-role-module convention at ${scope}`,
          ],
          ["an observed dedicated-role-module convention for one of the roles"]
        )
      );
    }
  }
}
