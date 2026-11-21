import { moduleEdgeShardFile, moduleShardFile } from "./dataset-layout";
import { fileFootprint, placeFiles } from "./file-placement";
import type {
  SemanticsModuleEdgeShard,
  SemanticsModuleIndex,
  SemanticsModuleIndexEntry,
  SemanticsModuleRecord,
  SemanticsModuleShard,
} from "./semantics-types";
import { DATASET_SCHEMA_VERSION } from "./semantics-types";

export function computeModuleDataset(
  byPackage: ReadonlyMap<string, SemanticsModuleRecord[]>,
  edgeShards: readonly SemanticsModuleEdgeShard[]
): { index: SemanticsModuleIndex; shards: SemanticsModuleShard[] } {
  const shardPackages = [...byPackage.keys()].sort();
  const shards: SemanticsModuleShard[] = [];

  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  for (const edge of edgeShards.flatMap((shard) => shard.edges)) {
    fanIn.set(edge.target, (fanIn.get(edge.target) ?? 0) + 1);
    fanOut.set(edge.source, (fanOut.get(edge.source) ?? 0) + 1);
  }
  const entries: SemanticsModuleIndexEntry[] = [];
  for (const id of shardPackages) {
    const shard: SemanticsModuleShard = {
      modules: byPackage.get(id) ?? [],
      package: id,
    };
    shards.push(shard);
    const placed = shard.modules
      .map((module) => ({
        directory: module.path.slice(0, module.path.lastIndexOf("/")),
        id: module.id,
        x: 0,
        y: 0,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    placeFiles(
      placed,
      fileFootprint(placed.length),
      edgeShards.find((edges) => edges.package === id)?.edges ?? []
    );
    const positions = new Map(
      placed.map((file) => [file.id, { x: file.x, y: file.y }])
    );
    for (const module of shard.modules) {
      entries.push({
        fanIn: fanIn.get(module.id) ?? 0,
        fanOut: fanOut.get(module.id) ?? 0,
        id: module.id,
        mapPosition: positions.get(module.id),
        package: id,
        path: module.path,
        shard: moduleShardFile(id),
        ...(module.role !== undefined && { role: module.role }),
        ...(module.fileKind !== undefined && { fileKind: module.fileKind }),
      });
    }
  }
  const moduleIndex: SemanticsModuleIndex = {
    coverage: {
      moduleEdges: "sharded",
      note: "Module record dependencies list cross-package module edges only. Every directed edge, intra-package and cross-package, is in the edge shard of the package owning its source module.",
    },
    edgeShards: edgeShards.map((shard) => ({
      crossPackage: shard.edges.filter((e) => e.scope === "cross-package")
        .length,
      file: moduleEdgeShardFile(shard.package),
      intraPackage: shard.edges.filter((e) => e.scope === "intra-package")
        .length,
      package: shard.package,
    })),
    modules: entries.sort((a, b) => a.id.localeCompare(b.id)),
    schemaVersion: DATASET_SCHEMA_VERSION,
    shards: shardPackages.map((id) => ({
      count: byPackage.get(id)?.length ?? 0,
      file: moduleShardFile(id),
      package: id,
    })),
  };
  return { index: moduleIndex, shards };
}
