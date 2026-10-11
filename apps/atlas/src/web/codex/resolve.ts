import { SEMANTICS_DECLARED_DEPENDENCY_KINDS } from "../../lib/semantics-types";
import type { CodexSource } from "./source";
import type { Codex, CodexPlacement, CodexRetiredPackage } from "./vocabulary";

/** The files at each end of a package pair's imports. */
export interface PairEndpoints {
  consumerFiles: readonly string[];
  supplierFiles: readonly string[];
}

/**
 * Each ordered package pair's endpoint files, from the import edges that
 * cross from one package into another: one pass over the edges, keyed by
 * `from` and `to`. The pair's count is the dependency graph's, not a
 * recount.
 */
export function pairEndpoints(
  imports: readonly { source: string; target: string }[],
  packageOf: ReadonlyMap<string, string>
): (from: string, to: string) => PairEndpoints {
  const pairs = new Map<
    string,
    { sources: Set<string>; targets: Set<string> }
  >();
  for (const edge of imports) {
    const from = packageOf.get(edge.source);
    const to = packageOf.get(edge.target);
    if (from === undefined || to === undefined || from === to) {
      continue;
    }
    const key = JSON.stringify([from, to]);
    let pair = pairs.get(key);
    if (pair === undefined) {
      pair = { sources: new Set(), targets: new Set() };
      pairs.set(key, pair);
    }
    pair.sources.add(edge.source);
    pair.targets.add(edge.target);
  }
  return (from, to) => {
    const pair = pairs.get(JSON.stringify([from, to]));
    return {
      consumerFiles: [...(pair?.sources ?? [])].sort(),
      supplierFiles: [...(pair?.targets ?? [])].sort(),
    };
  };
}

export function resolveCodex(source: CodexSource): Codex {
  const dependents = new Map<string, number>();
  const dependencies = new Map<string, number>();
  for (const edge of source.imports) {
    dependents.set(edge.target, (dependents.get(edge.target) ?? 0) + 1);
    dependencies.set(edge.source, (dependencies.get(edge.source) ?? 0) + 1);
  }
  const measured = new Map(
    source.fileRoles.flatMap((pkg) => pkg.modules.map((m) => [m.module, m]))
  );
  const roles = new Map(source.fileRoles.map((pkg) => [pkg.id, pkg]));
  const groups = new Map(
    source.responsibilityGroups.map((pkg) => [pkg.id, pkg])
  );
  const endpoints = pairEndpoints(
    source.imports,
    new Map(source.modules.map((m) => [m.id, m.package]))
  );
  const current = new Set(source.packages.map((p) => p.id));
  const paths = new Map(source.packagePaths.map((p) => [p.id, p.path]));
  return {
    declaredDependencies: source.declaredDependencies.flatMap(
      ({ package: from, declared }) =>
        SEMANTICS_DECLARED_DEPENDENCY_KINDS.flatMap((kind) =>
          Object.keys(declared[kind] ?? {})
            .filter((to) => current.has(to) && to !== from)
            .map((to) => ({ from, kind, to }))
        )
    ),
    dependencies: source.dependencies.map((d) => ({
      ...endpoints(d.from, d.to),
      from: d.from,
      sharedConcepts: d.concepts.total,
      strength: d.dependency.moduleEdges,
      to: d.to,
    })),
    imports: source.imports.map((edge) => ({
      source: edge.source,
      target: edge.target,
    })),
    modules: source.modules.map((m) => ({
      dependencies: dependencies.get(m.id) ?? 0,
      dependents: dependents.get(m.id) ?? 0,
      directory: m.path.slice(0, m.path.lastIndexOf("/")),
      fileKind: m.fileKind ?? "unknown",
      highFanIn: measured.get(m.id)?.highFanIn ?? false,
      id: m.id,
      internalFanIn: measured.get(m.id)?.fanIn ?? 0,
      package: m.package,
      path: m.path,
    })),
    packages: source.packages.map((p) => {
      const saved = roles.get(p.id);
      const grouped = groups.get(p.id);
      return {
        analyzed: p.analyzed,
        fileRoles: saved && { modules: saved.modules },
        highFanInCutoff: saved?.highFanInCutoff ?? 0,
        id: p.id,
        label: shortName(p.id),
        layer: p.layer,
        path: paths.get(p.id) ?? "",
        responsibilityGroups: grouped && {
          groups: grouped.groups,
          independent: grouped.independent,
        },
        size: p.modules.total,
      };
    }),
    placement: {
      dominantShare: source.placement.policy.dominantShare,
      labelled: source.placement.packages.map((p) => p.id),
      places: source.placement.places.map(resolvePlacement),
    },
    proximity: {
      apart: source.proximity.apart,
      close: source.proximity.close,
      labelled: source.proximity.packages.map((p) => p.id),
    },
    retiredPackages: source.history && retiredPackages(source.history, current),
    workspace: {
      coverage: source.dataset.coverage,
      surveyedAt: source.dataset.generatedAt,
    },
  };
}

/**
 * A placement's key, `level:place`: a package's root and a folder share a
 * path form, so the level keeps every key unique.
 */
export function placementKey(
  placement: Pick<CodexPlacement, "level" | "place">
): string {
  return `${placement.level}:${placement.place}`;
}

/** A place's use as counts, with its dominance share. */
function resolvePlacement(
  placement: CodexSource["placement"]["places"][number]
): CodexPlacement {
  const away = placement.away.map((entry) => ({
    modules: entry.modules.length,
    package: entry.package,
  }));
  const home = placement.home.modules.length;
  const consumers = away.reduce((sum, entry) => sum + entry.modules, home);
  const toward = placement.label === "departs" ? placement.toward : undefined;
  const held =
    toward === undefined
      ? Math.max(home, ...away.map((entry) => entry.modules))
      : (away.find((entry) => entry.package === toward)?.modules ?? 0);
  return {
    away,
    home,
    label: placement.label,
    level: placement.level,
    package: placement.package,
    place: placement.place,
    share: consumers ? held / consumers : 0,
    ...(toward === undefined ? {} : { toward }),
    unindexed: placement.unindexed,
  };
}

/** A package's name without its scope: `@scope/core` is `core`. */
function shortName(id: string): string {
  return id.split("/").at(-1) ?? id;
}

function retiredPackages(
  history: NonNullable<CodexSource["history"]>,
  current: ReadonlySet<string>
): CodexRetiredPackage[] {
  const complete = new Map(
    history.snapshots
      .filter((snapshot) => snapshot.status === "complete")
      .map((snapshot) => [snapshot.commit, snapshot.timestamp])
  );
  return [...history.packages]
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap((pkg) => {
      if (current.has(pkg.id)) {
        return [];
      }
      const lastSeen = pkg.checkpoints
        .map((commit) => complete.get(commit))
        .filter((time): time is string => !!time)
        .sort()
        .at(-1);
      return lastSeen
        ? [{ id: pkg.id, label: shortName(pkg.id), lastSeen }]
        : [];
    });
}
