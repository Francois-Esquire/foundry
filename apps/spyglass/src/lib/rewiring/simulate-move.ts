import type {
  BeforeAfter,
  ConventionAlignment,
  CycleOutcome,
  LocalityRelation,
  SymbolMovementClosure,
} from "../internal-rewiring-types";
import type {
  InternalModuleEdge,
  InternalModuleNode,
  InternalSymbolConsumer,
} from "../internal-topology-types";
import type {
  ArchitecturalRole,
  ArchitecturalRoleFinding,
  PrimitiveModuleFinding,
} from "../primitive-convention-types";
import { type MoveSimulation, same, scopeGroupKey, sorted } from "./common";
import type { RewiringFacts } from "./facts";
import type { MovementAnalysis } from "./movement";
export function simulateSymbolMove(
  group: ArchitecturalRoleFinding[],
  module: string,
  targetModule: string | undefined,
  targetRegion: string | undefined,
  conventions: {
    alignment: ConventionAlignment;
    conventionIds: string[];
  },
  after: LocalityRelation,
  before: LocalityRelation,
  index: Pick<
    RewiringFacts,
    | "consumersOf"
    | "edgeByKey"
    | "classifyEdge"
    | "regionOf"
    | "moduleNode"
    | "stillCyclic"
    | "reaches"
    | "moduleFinding"
    | "findingsByModule"
    | "primaryModules"
  >,
  movement: Pick<MovementAnalysis, "closureOf">
): MoveSimulation {
  const ids = new Set(group.map((f) => f.symbolId));
  const touched = new Map<string, Set<string>>();
  indexAffectedConsumers(group, index.consumersOf, module, touched);
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
  ({ retargeted, added } = simulateConsumerEdges(
    touched,
    index.edgeByKey,
    consumers,
    ids,
    counts,
    index.classifyEdge,
    removed,
    retargeted,
    edgeList,
    targetModule,
    added,
    index.regionOf,
    targetRegion
  ));
  const closure = movement.closureOf([...ids], module);
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
  const node = index.moduleNode.get(module);
  // A consumer reaching the group through a re-export loses its edge to
  // the forwarding module, not to the declaring one.
  const removedByTarget = new Map<string, Set<string>>();
  indexRemovedEdges(removed, removedByTarget);
  const fanInAfter =
    (node?.fanIn ?? 0) - (removedByTarget.get(module)?.size ?? 0);
  const forwarding = [...removedByTarget.entries()]
    .filter(([target]) => target !== module)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([target, sources]) => {
      const via = index.moduleNode.get(target);
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
  if (membership.length > 0 && !index.stillCyclic(module, removed)) {
    outcome = "membership-removed";
    detail = `${module} leaves ${membership[0] ?? ""} once ${removed.size} edges go`;
  }
  const reachesTarget =
    targetRegion === undefined
      ? index.reaches(module, (m) => consumers.has(m))
      : index.reaches(module, (m) => index.regionOf(m) === targetRegion);
  ({ outcome, detail } = assessMoveCycles(
    back,
    reachesTarget,
    outcome,
    detail,
    closure,
    module,
    reverse,
    retargeted
  ));
  const declaringRegion = index.regionOf(module);
  const crossingBefore = group.filter((f) =>
    f.consumers.responsibilities.some((r) => r !== declaringRegion)
  ).length;
  const crossingAfter =
    targetRegion === undefined
      ? crossingBefore
      : group.filter((f) =>
          f.consumers.responsibilities.some((r) => r !== targetRegion)
        ).length;
  const finding = index.moduleFinding.get(module);
  const exported = (index.findingsByModule.get(module) ?? []).filter(
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
  return assembleMoveSimulation(
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
    index.primaryModules,
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
function assembleMoveSimulation(
  closure: SymbolMovementClosure,
  edgeList: {
    source: string;
    target: string;
    symbolIds: string[];
  }[],
  conventions: {
    alignment: ConventionAlignment;
    conventionIds: string[];
  },
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
    fanIn: {
      after: number;
      before: number;
    };
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
    cross: {
      after: number;
      before: number;
    };
    unresolved: {
      after: number;
      before: number;
    };
    within: {
      after: number;
      before: number;
    };
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
function assessMoveCycles(
  back: boolean,
  reachesTarget: boolean,
  initialOutcome: CycleOutcome,
  initialDetail: string | undefined,
  closure: SymbolMovementClosure,
  module: string,
  reverse: boolean,
  retargeted: number
): {
  outcome: CycleOutcome;
  detail: string | undefined;
} {
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
function indexRemovedEdges(
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
function indexAffectedConsumers(
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
function simulateConsumerEdges(
  touched: Map<string, Set<string>>,
  edgeByKey: Map<string, InternalModuleEdge>,
  consumers: Set<string>,
  ids: Set<string>,
  counts: {
    cross: {
      after: number;
      before: number;
    };
    unresolved: {
      after: number;
      before: number;
    };
    within: {
      after: number;
      before: number;
    };
  },
  classifyEdge: (
    source: string,
    target: string
  ) => "within" | "cross" | "unresolved",
  removed: Set<string>,
  initialRetargeted: number,
  edgeList: {
    source: string;
    target: string;
    symbolIds: string[];
  }[],
  targetModule: string | undefined,
  initialAdded: number,
  regionOf: (module: string) => string | undefined,
  targetRegion: string | undefined
): {
  retargeted: number;
  added: number;
} {
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
