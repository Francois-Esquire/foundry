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

/**
 * The canonical absolute root a Workspace stores.
 *
 * Resolving symlinks here is what makes "one Workspace per source" true for two
 * different spellings of the same directory.
 */
export async function canonicalizeRoot(
  filesystem: Pick<StorageReader, "lstat" | "realpath">,
  selected: string
): Promise<string> {
  // None of these messages echo the selected path. They reach callers outside
  // the trust boundary, which must never learn an absolute root — not as data
  // and not as error text. The cause carries the detail for a log.
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

/**
 * Confirms the root a Workspace already stores is still that same directory.
 *
 * Separate from `canonicalizeRoot`, which validates a person's fresh selection
 * and speaks the invalid-input vocabulary. A root that moved out from under an
 * existing Workspace is a source problem, not a bad request.
 */
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

/**
 * The source's own spelling of one stored relative path, or null when no such
 * File is there.
 *
 * A stored path is normalized; the name on disk may not be. On a filesystem
 * that stores what it was given byte-for-byte, joining the root to the
 * composed spelling opens nothing even though the File is present — which
 * would read as "deleted". So each segment is tried directly first, and only
 * on a miss is the parent listed for an entry that normalizes to it.
 */
export async function resolveStoredPath(
  filesystem: Pick<StorageReader, "readDirectory" | "lstat" | "separator">,
  canonicalRoot: string,
  relativePath: string
): Promise<string | null> {
  let absolute = canonicalRoot;
  for (const segment of relativePath.split("/")) {
    const direct = joinFilesystemPath(absolute, segment, filesystem.separator);
    // Operations are intentionally sequential to preserve observation and mutation order.
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

/**
 * The complete inventory of one root, as the facts a catalog stores.
 *
 * A filesystem with its own authoritative `tree` answers directly; any other
 * is walked and read. Either way the result is validated once, here.
 */
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

/**
 * The complete candidate inventory of one canonical root, walked and read.
 *
 * Everything is observed before anything is returned. A traversal, stat, or
 * read failure aborts the whole scan — a partial inventory committed as a
 * catalog would read as "every unobserved file was deleted".
 */
export async function scanDirectory(
  filesystem: StorageReader,
  canonicalRoot: string
): Promise<readonly ObservedFacts[]> {
  await verifyRoot(filesystem, canonicalRoot);
  const nodes: [string, StorageNode][] = [];
  for (const entry of await walkEntries(filesystem, canonicalRoot)) {
    // Operations are intentionally sequential to preserve observation order.
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
  // One opened byte sequence answers both the digest and the size. A
  // metadata-only size would let the two disagree about which moment they
  // observed. Mime is left to classification.
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

/** The facts of every entry in a valid tree, in code-unit path order. */
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
