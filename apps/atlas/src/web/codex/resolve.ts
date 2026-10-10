import { SEMANTICS_DECLARED_DEPENDENCY_KINDS } from "../../lib/semantics-types";
import type { CodexSource } from "./source";
import type { Codex, CodexRetiredPackage } from "./vocabulary";

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
  const current = new Set(source.packages.map((p) => p.id));
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
        layer: p.layer ?? 0,
        responsibilityGroups: grouped && {
          groups: grouped.groups,
          independent: grouped.independent,
        },
        size: p.modules.total,
      };
    }),
    retiredPackages: source.history && retiredPackages(source.history, current),
    workspace: {
      coverage: source.dataset.coverage,
      surveyedAt: source.dataset.generatedAt,
    },
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
