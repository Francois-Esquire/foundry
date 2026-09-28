import type {
  SemanticsHistoryEntities,
  SemanticsHistoryManifest,
  SemanticsHistorySnapshotRef,
} from "../../lib/semantics-history-types";
import type {
  SemanticsManifest,
  SemanticsModuleEdge,
  SemanticsModuleEdgeShard,
  SemanticsModuleIndex,
  SemanticsModuleIndexEntry,
  SemanticsModuleRecord,
  SemanticsModuleShard,
} from "../../lib/semantics-types";
import type {
  WorkspaceDependencyEdgeProjection,
  WorkspaceGraphProjection,
  WorkspaceGraphProjectionNode,
} from "../../lib/workspace-projection-types";
import type { DeclaredDependencyKind } from "./vocabulary";

/** Every source field the codex reads. Resolvers see nothing else. */
export interface CodexSource {
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
  manifests: {
    declared: Partial<Record<DeclaredDependencyKind, Record<string, string>>>;
    package: string;
  }[];
  modules: Pick<
    SemanticsModuleIndexEntry,
    "id" | "package" | "path" | "fileKind"
  >[];
  packages: Pick<
    WorkspaceGraphProjectionNode,
    "id" | "label" | "analyzed" | "layer"
  >[];
  participation: Pick<SemanticsModuleRecord, "id" | "concepts">[];
  survey: Pick<SemanticsManifest, "generatedAt" | "coverage">;
}

export async function readCodexSource(
  signal?: AbortSignal
): Promise<CodexSource> {
  const read = async <T>(file: string): Promise<T> => {
    const response = await fetch(`/data/${file}`, {
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `Could not load ${file} (${response.status}). Run atlas scan to generate the dataset.`
      );
    }
    return (await response.json()) as T;
  };
  const manifest = await read<SemanticsManifest>("manifest.json");
  if (manifest.schemaVersion !== 3) {
    throw new Error(
      `Unsupported semantics dataset version ${manifest.schemaVersion}.`
    );
  }
  const [index, graph] = await Promise.all([
    read<SemanticsModuleIndex>(manifest.files.moduleIndex),
    read<WorkspaceGraphProjection>(manifest.files.projections.dependencyGraph),
  ]);
  const [edgeShards, moduleShards, manifests, history] = await Promise.all([
    Promise.all(
      index.edgeShards.map((s) => read<SemanticsModuleEdgeShard>(s.file))
    ),
    Promise.all(index.shards.map((s) => read<SemanticsModuleShard>(s.file))),
    Promise.all(
      manifest.packages.map(async (p) => ({
        declared: await read<CodexSource["manifests"][number]["declared"]>(
          `manifests/${encodeURIComponent(p.id.replaceAll("/", "__"))}.json`
        ),
        package: p.id,
      }))
    ),
    readHistory(read, signal),
  ]);
  return {
    dependencies: graph.edges.flatMap((e) =>
      e.kind === "dependency" ? [e] : []
    ),
    history,
    imports: edgeShards.flatMap((s) => s.edges),
    manifests,
    modules: index.modules,
    packages: graph.nodes,
    participation: moduleShards.flatMap((s) => s.modules),
    survey: manifest,
  };
}

async function readHistory(
  read: <T>(file: string) => Promise<T>,
  signal?: AbortSignal
): Promise<CodexSource["history"]> {
  const manifest = await fetch("/data/history/manifest.json", {
    cache: "no-store",
    signal,
  });
  if (!manifest.ok) {
    if (manifest.status !== 404) {
      throw new Error(`Could not load history (${manifest.status}).`);
    }
    return;
  }
  const entities = await read<SemanticsHistoryEntities>(
    "history/entities.json"
  );
  return {
    packages: entities.packages,
    snapshots: ((await manifest.json()) as SemanticsHistoryManifest).snapshots,
  };
}
