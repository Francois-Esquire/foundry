import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
} from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

import type { StorageNode, StorageTree } from "@foundry/core/storage";
import { validateStorageTree } from "@foundry/core/storage";
import { sha256Hex } from "@foundry/lib/digest";
import { isFilesystemPathWithin } from "@foundry/lib/paths";

import { lstatOrNull, writeAtomically } from "./fs";

/** Streams the stored bytes of the file at a tree path. */
export type ReadTreeFile = (path: string) => Promise<AsyncIterable<Uint8Array>>;

type SpecialNode = Extract<StorageNode, { type: "socket" | "pipe" | "device" }>;

/**
 * Make `root` mirror `tree`. Paths absent from the tree are removed, changed
 * files are replaced atomically, and catalog-only nodes (sockets, pipes,
 * devices) leave nothing new on disk.
 */
export async function materialize(
  root: string,
  tree: StorageTree,
  read: ReadTreeFile
): Promise<void> {
  validateStorageTree(tree);
  await ensureDirectory(root);
  await prune(root, "", tree);
  const shallowFirst = Object.entries(tree).sort(
    ([a], [b]) => a.split("/").length - b.split("/").length
  );
  for (const [path, node] of shallowFirst) {
    const target = join(root, ...path.split("/"));
    await confinedParents(root, target);
    await place(target, node, () => read(path));
  }
}

async function place(
  target: string,
  node: StorageNode,
  read: () => Promise<AsyncIterable<Uint8Array>>
): Promise<void> {
  const existing = await lstatOrNull(target);
  switch (node.type) {
    case "directory":
      await ensureDirectory(target, existing);
      return;
    case "symlink":
      if (
        existing?.isSymbolicLink() &&
        (await readlink(target)) === node.target
      ) {
        return;
      }
      await rm(target, { force: true, recursive: true });
      await symlink(node.target, target);
      return;
    case "file":
      if (
        existing?.isFile() &&
        (await sha256Hex(await readFile(target))) === node.digest
      ) {
        return;
      }
      if (existing && !existing.isFile()) {
        await rm(target, { force: true, recursive: true });
      }
      await writeAtomically(
        target,
        join(
          dirname(target),
          `.${basename(target)}.${crypto.randomUUID()}.tmp`
        ),
        await read()
      );
      return;
    default:
      if (existing && !isSpecial(node, existing)) {
        await rm(target, { force: true, recursive: true });
      }
  }
}

function isSpecial(node: SpecialNode, stats: Stats): boolean {
  switch (node.type) {
    case "socket":
      return stats.isSocket();
    case "pipe":
      return stats.isFIFO();
    default:
      return stats.isBlockDevice() || stats.isCharacterDevice();
  }
}

async function ensureDirectory(
  path: string,
  existing?: Stats | null
): Promise<void> {
  const stats = existing === undefined ? await lstatOrNull(path) : existing;
  if (stats && !stats.isDirectory()) {
    await rm(path, { force: true, recursive: true });
  }
  await mkdir(path, { recursive: true });
}

/** Every parent between `root` and `target` is a real directory inside `root`. */
async function confinedParents(root: string, target: string): Promise<void> {
  let parent = dirname(target);
  while (parent !== root) {
    if (!isFilesystemPathWithin(root, parent, sep)) {
      throw new Error("Path escapes Artifact root");
    }
    const entry = await lstatOrNull(parent);
    if (!entry?.isDirectory()) {
      throw new Error("Artifact parent is not a directory");
    }
    parent = dirname(parent);
  }
  if (!(await lstat(root)).isDirectory()) {
    throw new Error("Artifact root is not a directory");
  }
}

async function prune(
  root: string,
  prefix: string,
  tree: StorageTree
): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    const target = join(root, entry.name);
    if (!Object.hasOwn(tree, path)) {
      await rm(target, { force: true, recursive: true });
    } else if (entry.isDirectory() && tree[path]?.type === "directory") {
      await prune(target, `${path}/`, tree);
    }
  }
}
