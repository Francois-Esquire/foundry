import type { Dirent } from "node:fs";
import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

import type { StorageNode, StorageTree } from "@foundry/core/storage";
import { sha256Hex } from "@foundry/lib/digest";

import type { EntryInputs, TreeChanges } from "../substrate";

/** A storage node without store-owned fields such as `blobId`. */
export function descriptor(node: StorageNode): StorageNode {
  if (node.type !== "file") {
    return node;
  }
  return {
    bytes: node.bytes,
    digest: node.digest,
    mime: node.mime,
    type: "file",
  };
}

/** The changes that turn `baseline` into the tree found under `root`. */
export async function diffDirectory(
  root: string,
  baseline: StorageTree
): Promise<Required<Pick<TreeChanges, "put" | "remove">> | null> {
  const disk = await scan(root);
  const put: Record<string, EntryInputs[string]> = Object.create(null);
  for (const [path, node] of Object.entries(disk)) {
    const previous = Object.hasOwn(baseline, path) ? baseline[path] : undefined;
    if (sameNode(node, previous)) {
      continue;
    }
    put[path] =
      node.type === "file"
        ? {
            bytes: await readFile(join(root, ...path.split("/"))),
            mime: previous?.type === "file" ? previous.mime : null,
          }
        : node;
  }
  // Catalog-only nodes never appear on disk, so their absence is no removal.
  const remove = Object.entries(baseline)
    .filter(
      ([path, node]) =>
        !(path in disk) &&
        (node.type === "file" ||
          node.type === "directory" ||
          node.type === "symlink")
    )
    .map(([path]) => path);
  return Object.keys(put).length > 0 || remove.length > 0
    ? { put, remove }
    : null;
}

function sameNode(
  node: StorageNode,
  previous: StorageNode | undefined
): boolean {
  if (node.type === "file") {
    return (
      previous?.type === "file" &&
      previous.digest === node.digest &&
      previous.bytes === node.bytes
    );
  }
  if (node.type === "symlink") {
    return previous?.type === "symlink" && previous.target === node.target;
  }
  return previous?.type === node.type;
}

/** Describe every entry under `root`, hashing each regular file. */
export async function scan(root: string): Promise<StorageTree> {
  const tree: Record<string, StorageNode> = Object.create(null);
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      const target = join(directory, entry.name);
      const node = await describeEntry(entry, target);
      if (node) {
        tree[path] = node;
      }
      if (node?.type === "directory") {
        await walk(target, `${path}/`);
      }
    }
  }
  await walk(root, "");
  return tree;
}

async function describeEntry(
  entry: Dirent,
  target: string
): Promise<StorageNode | null> {
  if (entry.isSymbolicLink()) {
    return { target: await readlink(target), type: "symlink" };
  }
  if (entry.isDirectory()) {
    return { type: "directory" };
  }
  if (entry.isFile()) {
    const bytes = await readFile(target);
    return {
      bytes: bytes.byteLength,
      digest: await sha256Hex(bytes),
      mime: null,
      type: "file",
    };
  }
  if (entry.isSocket()) {
    return { type: "socket" };
  }
  if (entry.isFIFO()) {
    return { type: "pipe" };
  }
  if (entry.isBlockDevice() || entry.isCharacterDevice()) {
    return { type: "device" };
  }
  return null;
}
