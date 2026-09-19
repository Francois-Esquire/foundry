import type { DirectoryEntry, StorageReader } from "@foundry/core/storage";
import { storageTree } from "@foundry/core/storage";
import { sha256Hex } from "@foundry/lib/digest";
import { classifyFile } from "@foundry/lib/file-classification";
import { joinFilesystemPath } from "@foundry/lib/paths";
import {
  InvalidWorkspaceInputError,
  sourceIssueFor,
  WorkspaceSourceUnavailableError,
} from "./errors";
import { walkEntries } from "./traverse";
import type { ObservedFacts, WorkspaceSourceIssue } from "./types";

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
  // None of these messages echo the selected path. They are mapped straight
  // onto a tRPC error, and the renderer must never learn an absolute root —
  // not as data and not as error text. The cause carries the detail for a log.
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
 * A root that is not there is `unavailable`; every other errno means the same
 * thing at the root as it does one directory deeper, so it goes through the
 * same classifier rather than being flattened to "gone".
 */
function rootIssueFor(cause: unknown): WorkspaceSourceIssue {
  const code: unknown = (cause as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR"
    ? "unavailable"
    : sourceIssueFor(cause);
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
 * The complete candidate inventory for one canonical root.
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
  const walked = await walkEntries(filesystem, canonicalRoot);
  const candidates: ObservedFacts[] = [];

  for (const file of walked) {
    const path = file.relativePath;
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (file.type !== "file") {
      if (file.type === "symlink") {
        try {
          const target = await filesystem.readLink(file.absolutePath);
          candidates.push({ name, path, target, type: "symlink" });
        } catch (cause) {
          throw new WorkspaceSourceUnavailableError(
            `Could not read link ${path}`,
            { cause }
          );
        }
      } else {
        candidates.push({ name, path, type: file.type });
      }
      continue;
    }
    // One opened byte sequence answers both the digest and the size. A
    // metadata-only size would let the two disagree about which moment they
    // observed.
    let bytes: Uint8Array;
    try {
      // Operations are intentionally sequential to preserve observation and mutation order.
      bytes = await filesystem.readFile(file.absolutePath);
    } catch (error) {
      throw new WorkspaceSourceUnavailableError(
        `Could not read ${file.relativePath}`,
        { cause: error, issue: sourceIssueFor(error) }
      );
    }
    const classification = classifyFile(file.relativePath);
    candidates.push({
      bytes: bytes.byteLength,
      digest: await sha256Hex(bytes),
      extension: classification.extension,
      kind: classification.kind,
      mime: classification.mime,
      name: classification.name,
      path: file.relativePath,
      type: "file",
    });
  }

  try {
    storageTree(candidates);
  } catch (cause) {
    throw new WorkspaceSourceUnavailableError("Invalid source tree", { cause });
  }
  return candidates;
}
