import type { DatasetReader } from "../../lib/dataset";
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
import type {
  WorkspaceDependencyEdgeProjection,
  WorkspaceGraphProjectionNode,
} from "../../lib/workspace-projection-types";

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
  packages: Pick<
    WorkspaceGraphProjectionNode,
    "id" | "label" | "analyzed" | "layer"
  >[];
  participation: Pick<SemanticsModuleRecord, "id" | "concepts">[];
}

/** The codex's fields, read through one dataset reader. */
export async function readCodexSource(
  reader: DatasetReader
): Promise<CodexSource> {
  const [manifest, index, graph, edgeShards, moduleShards, history] =
    await Promise.all([
      reader.manifest(),
      reader.moduleIndex(),
      reader.dependencyGraph(),
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
    history: history && {
      packages: history.entities.packages,
      snapshots: history.manifest.snapshots,
    },
    imports: edgeShards.flatMap((s) => s.edges),
    modules: index.modules,
    packages: graph.nodes,
    participation: moduleShards.flatMap((s) => s.modules),
  };
}
