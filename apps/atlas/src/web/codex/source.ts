import type { DatasetReader } from "../../lib/dataset";
import type { FileRolesPackage } from "../../lib/lenses/file-roles-types";
import type { PackageSize } from "../../lib/lenses/package-sizes-types";
import type { ResponsibilityGroupsPackage } from "../../lib/lenses/responsibility-groups-types";
import type {
  SemanticsHistoryEntities,
  SemanticsHistorySnapshotRef,
} from "../../lib/semantics-history-types";
import type {
  DatasetManifest,
  SemanticsDeclaredDependencies,
  SemanticsModuleEdge,
  SemanticsModuleIndexEntry,
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
  /** The `responsibility-groups` lens, drawn as districts on entering an island. */
  responsibilityGroups: ResponsibilityGroupsPackage[];
}

/** The codex's fields, read through one dataset reader. */
export async function readCodexSource(
  reader: DatasetReader
): Promise<CodexSource> {
  const [manifest, index, graph, sizes, roles, groups, edgeShards, history] =
    await Promise.all([
      reader.manifest(),
      reader.moduleIndex(),
      reader.dependencyGraph(),
      reader.lens("package-sizes"),
      reader.lens("file-roles"),
      reader.lens("responsibility-groups"),
      reader.moduleEdgeShards(),
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
    responsibilityGroups: groups.packages,
  };
}
