import type { CodexSource } from "./source";
import type {
  Codex,
  CodexRetiredPackage,
  DeclaredDependencyKind,
} from "./vocabulary";

const declaredKinds: DeclaredDependencyKind[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

export function resolveCodex(source: CodexSource): Codex {
  const concepts = new Map(
    source.participation.map((m) => [
      m.id,
      [...new Set(Object.values(m.concepts).flat())],
    ])
  );
  const dependents = new Map<string, number>();
  const dependencies = new Map<string, number>();
  for (const edge of source.imports) {
    dependents.set(edge.target, (dependents.get(edge.target) ?? 0) + 1);
    dependencies.set(edge.source, (dependencies.get(edge.source) ?? 0) + 1);
  }
  const sizes = new Map<string, number>();
  for (const m of source.modules) {
    sizes.set(m.package, (sizes.get(m.package) ?? 0) + 1);
  }
  const current = new Set(source.packages.map((p) => p.id));
  return {
    declaredDependencies: source.manifests.flatMap(
      ({ package: from, declared }) =>
        declaredKinds.flatMap((kind) =>
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
      concepts: concepts.get(m.id) ?? [],
      dependencies: dependencies.get(m.id) ?? 0,
      dependents: dependents.get(m.id) ?? 0,
      directory: m.path.slice(0, m.path.lastIndexOf("/")),
      fileKind: m.fileKind ?? "unknown",
      id: m.id,
      package: m.package,
      path: m.path,
    })),
    packages: [...source.packages]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => ({
        analyzed: p.analyzed,
        id: p.id,
        label: p.label,
        layer: p.layer ?? 0,
        size: sizes.get(p.id) ?? 0,
      })),
    retiredPackages: source.history && retiredPackages(source.history, current),
    workspace: {
      coverage: source.survey.coverage,
      surveyedAt: source.survey.generatedAt,
    },
  };
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
        ? [{ id: pkg.id, label: pkg.id.split("/").at(-1) ?? pkg.id, lastSeen }]
        : [];
    });
}
