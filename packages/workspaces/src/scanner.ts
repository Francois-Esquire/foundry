import type {
  DirectoryEntry,
  StorageNode,
  StorageReader,
  StorageTree,
} from "@foundry/core/storage";
import { validateStorageTree } from "@foundry/core/storage";
import { sha256Hex } from "@foundry/lib/digest";
import { classifyFile } from "@foundry/lib/file-classification";
import { byCodeUnit } from "@foundry/lib/ordering";
import { joinFilesystemPath, lastPathSegment } from "@foundry/lib/paths";
import {
  InvalidWorkspaceInputError,
  rootIssueFor,
  sourceIssueFor,
  WorkspaceSourceUnavailableError,
} from "./errors";
import { walkEntries } from "./traverse";
import type { ObservedFacts, WalkedEntry, WorkspaceFileSystem } from "./types";

export async function canonicalizeRoot(
  filesystem: Pick<StorageReader, "lstat" | "realpath">,
  selected: string
): Promise<string> {
  let canonical: string;
  try {
    canonical = await filesystem.realpath(selected);
  } catch (error) {
    if (error instanceof WorkspaceSourceUnavailableError) {
      throw error;
    }
    throw new InvalidWorkspaceInputError("Selected root does not resolve", {
      cause: error,
    });
  }

  let stats: Awaited<ReturnType<typeof filesystem.lstat>>;
  try {
    stats = await filesystem.lstat(canonical);
  } catch (error) {
    if (error instanceof WorkspaceSourceUnavailableError) {
      throw error;
    }
    throw new InvalidWorkspaceInputError("Selected root is not readable", {
      cause: error,
    });
  }
  if (stats.type !== "directory") {
    throw new InvalidWorkspaceInputError("Selected root is not a directory");
  }
  return canonical;
}

export async function verifyRoot(
  filesystem: Pick<StorageReader, "lstat" | "realpath">,
  canonicalRoot: string
): Promise<void> {
  let resolved: string;
  try {
    resolved = await filesystem.realpath(canonicalRoot);
  } catch (error) {
    throw new WorkspaceSourceUnavailableError(
      "The Workspace source directory could not be resolved",
      { cause: error, issue: rootIssueFor(error) }
    );
  }
  if (resolved !== canonicalRoot) {
    throw new WorkspaceSourceUnavailableError(
      "The Workspace source directory no longer resolves to its own root",
      { issue: "unavailable" }
    );
  }

  let stats: Awaited<ReturnType<typeof filesystem.lstat>>;
  try {
    stats = await filesystem.lstat(canonicalRoot);
  } catch (error) {
    throw new WorkspaceSourceUnavailableError(
      "The Workspace source directory could not be inspected",
      { cause: error, issue: rootIssueFor(error) }
    );
  }
  if (stats.type !== "directory") {
    throw new WorkspaceSourceUnavailableError(
      "The Workspace source is no longer a directory",
      { issue: "unavailable" }
    );
  }
}

export async function resolveStoredPath(
  filesystem: Pick<StorageReader, "readDirectory" | "lstat" | "separator">,
  canonicalRoot: string,
  relativePath: string
): Promise<string | null> {
  let absolute = canonicalRoot;
  for (const segment of relativePath.split("/")) {
    const direct = joinFilesystemPath(absolute, segment, filesystem.separator);
    if (await exists(filesystem, direct)) {
      absolute = direct;
      continue;
    }

    let entries: readonly DirectoryEntry[];
    try {
      entries = await filesystem.readDirectory(absolute);
    } catch {
      return null;
    }
    const spelled = entries.find(
      (entry) => entry.name.normalize("NFC") === segment
    );
    if (!spelled) {
      return null;
    }
    absolute = joinFilesystemPath(absolute, spelled.name, filesystem.separator);
  }
  return absolute;
}

async function exists(
  filesystem: Pick<StorageReader, "lstat">,
  path: string
): Promise<boolean> {
  try {
    await filesystem.lstat(path);
    return true;
  } catch {
    return false;
  }
}

export async function scanSource(
  filesystem: StorageReader & Pick<WorkspaceFileSystem, "tree">,
  canonicalRoot: string
): Promise<readonly ObservedFacts[]> {
  if (!filesystem.tree) {
    return scanDirectory(filesystem, canonicalRoot);
  }
  let tree: StorageTree;
  try {
    tree = await filesystem.tree(canonicalRoot);
  } catch (cause) {
    if (cause instanceof WorkspaceSourceUnavailableError) {
      throw cause;
    }
    throw new WorkspaceSourceUnavailableError(
      "Could not read the Workspace tree",
      { cause, issue: "scan-failed" }
    );
  }
  return factsOf(tree);
}

export async function scanDirectory(
  filesystem: StorageReader,
  canonicalRoot: string
): Promise<readonly ObservedFacts[]> {
  await verifyRoot(filesystem, canonicalRoot);
  const nodes: [string, StorageNode][] = [];
  for (const entry of await walkEntries(filesystem, canonicalRoot)) {
    nodes.push([entry.relativePath, await readNode(filesystem, entry)]);
  }
  return factsOf(Object.fromEntries(nodes));
}

async function readNode(
  filesystem: StorageReader,
  entry: WalkedEntry
): Promise<StorageNode> {
  const path = entry.relativePath;
  if (entry.type === "symlink") {
    try {
      const target = await filesystem.readLink(entry.absolutePath);
      return { target, type: "symlink" };
    } catch (cause) {
      throw new WorkspaceSourceUnavailableError(`Could not read link ${path}`, {
        cause,
      });
    }
  }
  if (entry.type !== "file") {
    return { type: entry.type };
  }
  let bytes: Uint8Array;
  try {
    bytes = await filesystem.readFile(entry.absolutePath);
  } catch (error) {
    throw new WorkspaceSourceUnavailableError(`Could not read ${path}`, {
      cause: error,
      issue: sourceIssueFor(error),
    });
  }
  return {
    bytes: bytes.byteLength,
    digest: await sha256Hex(bytes),
    mime: null,
    type: "file",
  };
}

function factsOf(tree: StorageTree): ObservedFacts[] {
  try {
    validateStorageTree(tree);
  } catch (cause) {
    throw new WorkspaceSourceUnavailableError("Invalid source tree", { cause });
  }
  return Object.entries(tree)
    .sort(byCodeUnit(([path]) => path))
    .map(([path, node]): ObservedFacts => {
      if (node.type !== "file") {
        return { ...node, name: lastPathSegment(path), path };
      }
      const classification = classifyFile(path);
      return {
        ...classification,
        bytes: node.bytes,
        digest: node.digest,
        mime: node.mime ?? classification.mime,
        path,
        type: "file",
      };
    });
}
