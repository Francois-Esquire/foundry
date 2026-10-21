import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryManifest } from "../../src/lib/semantics-history-types";
import type {
  DatasetManifest,
  SemanticsModuleIndex,
} from "../../src/lib/semantics-types";

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Every file the dataset names, sorted: `manifest.json` itself and what it
 * names directly (lenses included) or through `modules/index.json`, and, when the dataset
 * includes history, what `history/manifest.json` names under `history/`.
 */
export function listedFiles(output: string): string[] {
  const manifest = readJson(join(output, "manifest.json")) as DatasetManifest;
  const index = readJson(
    join(output, manifest.files.moduleIndex)
  ) as SemanticsModuleIndex;
  const listed = new Set<string>([
    "manifest.json",
    manifest.files.workspace,
    manifest.files.moduleIndex,
    manifest.files.conceptIndex,
    ...Object.values(manifest.files.projections),
    ...Object.values(manifest.lenses).map((lens) => lens.file),
    ...index.shards.map((shard) => shard.file),
    ...index.edgeShards.map((shard) => shard.file),
    ...index.modules.map((module) => module.shard),
  ]);
  if (manifest.files.visualization !== undefined) {
    listed.add(manifest.files.visualization);
  }
  if (manifest.files.dependencyInventory !== undefined) {
    listed.add(manifest.files.dependencyInventory);
  }
  for (const pkg of manifest.packages) {
    for (const file of [
      pkg.report,
      pkg.projection,
      pkg.modules.shard,
      pkg.internals,
    ]) {
      if (file !== undefined) {
        listed.add(file);
      }
    }
  }
  const historyManifest = join(output, "history", "manifest.json");
  if (existsSync(historyManifest)) {
    const history = readJson(historyManifest) as HistoryManifest;
    for (const file of [
      ...Object.values(history.files),
      ...history.snapshots.flatMap((snapshot) => snapshot.file ?? []),
      ...history.deltas.map((delta) => delta.file),
    ]) {
      listed.add(`history/${file}`);
    }
  }
  return [...listed].sort();
}
