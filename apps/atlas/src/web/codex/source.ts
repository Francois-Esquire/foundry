import type { DatasetReader } from "../../lib/dataset";
import type { FileRolesPackage } from "../../lib/lenses/file-roles-types";
import type { PackageSize } from "../../lib/lenses/package-sizes-types";
import type {
  SemanticsHistoryEntities,
  SemanticsHistorySnapshotRef,
} from "../../lib/semantics-history-types";
import type {
  DatasetManifest,
  SemanticsDeclaredDependencies,
  SemanticsModuleEdge,
  SemanticsModuleIndexEntry,
  SemanticsModuleRecord,
} from "../../lib/semantics-types";
import type { WorkspaceDependencyEdgeProjection } from "../../lib/workspace-projection-types";

/** Every source field the codex reads. Resolvers see nothing else. */
export interface CodexSource {
  dataset: Pick<DatasetManifest, "generatedAt" | "coverage">;
  declaredDependencies: {
    declared: SemanticsDeclaredDependencies;
    package: string;
  }[];
  dependencies: (Pick<WorkspaceDependencyEdgeProjection, "from" | "to"> & {
    concepts: Pick<WorkspaceDependencyEdgeProjection["concepts"], "total">;
    dependency: Pick<
      WorkspaceDependencyEdgeProjection["dependency"],
      "moduleEdges"
    >;
  })[];
  /** The `file-roles` lens: fan-in raises summits; roles are bound on entering an island. */
  fileRoles: FileRolesPackage[];
  history?: {
    packages: SemanticsHistoryEntities["packages"];
    snapshots: Pick<
      SemanticsHistorySnapshotRef,
      "commit" | "timestamp" | "status"
    >[];
  };
  imports: Pick<SemanticsModuleEdge, "source" | "target">[];
  modules: Pick<
    SemanticsModuleIndexEntry,
    "id" | "package" | "path" | "fileKind"
  >[];
  /** The `package-sizes` lens, sorted by id. */
  packages: (Pick<PackageSize, "id" | "analyzed" | "layer"> & {
    modules: Pick<PackageSize["modules"], "total">;
  })[];
  participation: Pick<SemanticsModuleRecord, "id" | "concepts">[];
}

/** The codex's fields, read through one dataset reader. */
export async function readCodexSource(
  reader: DatasetReader
): Promise<CodexSource> {
  const [
    manifest,
    index,
    graph,
    sizes,
    roles,
    edgeShards,
    moduleShards,
    history,
  ] = await Promise.all([
    reader.manifest(),
    reader.moduleIndex(),
    reader.dependencyGraph(),
    reader.lens("package-sizes"),
    reader.lens("file-roles"),
    reader.moduleEdgeShards(),
    reader.moduleShards(),
    reader.history(),
  ]);
  return {
    dataset: manifest,
    declaredDependencies: manifest.packages.map((p) => ({
      declared: p.declaredDependencies,
      package: p.id,
    })),
    dependencies: graph.edges.flatMap((e) =>
      e.kind === "dependency" ? [e] : []
    ),
    fileRoles: roles.packages,
    history: history && {
      packages: history.entities.packages,
      snapshots: history.manifest.snapshots,
    },
    imports: edgeShards.flatMap((s) => s.edges),
    modules: index.modules,
    packages: sizes.packages,
    participation: moduleShards.flatMap((s) => s.modules),
  };
}
