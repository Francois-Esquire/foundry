import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { StorageTree } from "@foundry/core/storage";

import type { ContentId } from "../ref";
import type { Artifacts } from "../substrate";
import { lstatOrNull } from "./fs";
import { materialize } from "./materialize";
import { diffDirectory } from "./scan";

/** Part of one frozen Content, placed as real files outside any Artifact directory. */
export interface ContentProjection {
  readonly artifacts: Pick<Artifacts, "getContent" | "readFileRange">;
  readonly contentId: ContentId;
  /** Whether a tree path is projected; a projected path's parents must be too. */
  readonly include: (path: string) => boolean;
}

/**
 * Writes the projected entries into `directory`, which must not exist yet,
 * with the same file application `artifactFileSystem` uses, then checks every
 * byte against the Content's tree and leaves the files read-only. Unlike an
 * Artifact directory, nothing on disk is watched or written back.
 */
export async function stageProjection(
  projection: ContentProjection,
  directory: string,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  const tree = await projectedTree(projection);
  await mkdir(directory, { mode: 0o755 });
  await materialize(directory, tree, async (path) => {
    signal?.throwIfAborted();
    const file = await projection.artifacts.readFileRange(
      projection.contentId,
      path,
      { start: 0 }
    );
    if (!file) {
      throw new Error(`Missing Content file: ${path}`);
    }
    return file.body;
  });
  if (await diffDirectory(directory, tree)) {
    throw new Error(
      `Projected files of Content ${projection.contentId} failed verification`
    );
  }
  for (const [path, node] of Object.entries(tree)) {
    await chmod(
      join(directory, ...path.split("/")),
      node.type === "file" ? 0o444 : 0o755
    );
  }
  await chmod(directory, 0o755);
}

/** Whether `directory` holds exactly the projected entries, byte for byte. */
export async function projectionMatches(
  projection: ContentProjection,
  directory: string
): Promise<boolean> {
  const found = await lstatOrNull(directory);
  if (!found?.isDirectory()) {
    return false;
  }
  return (
    (await diffDirectory(directory, await projectedTree(projection))) === null
  );
}

async function projectedTree(
  projection: ContentProjection
): Promise<StorageTree> {
  const content = await projection.artifacts.getContent(projection.contentId);
  if (content?.state !== "frozen") {
    throw new Error(`Content ${projection.contentId} is not frozen`);
  }
  const tree: Record<string, StorageTree[string]> = Object.create(null);
  for (const [path, node] of Object.entries(content.tree)) {
    if (!projection.include(path)) {
      continue;
    }
    if (node.type !== "file" && node.type !== "directory") {
      throw new Error(`Cannot project the ${node.type} at ${path}`);
    }
    tree[path] = node;
  }
  return tree;
}
