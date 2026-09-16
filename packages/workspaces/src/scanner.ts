import { classifyFile } from "./classification";
import type { WorkspaceSourceIssue } from "./errors";
import {
  InvalidWorkspaceInputError,
  sourceIssueFor,
  WorkspaceSourceUnavailableError,
} from "./errors";
import type { DirectoryEntry, WorkspaceFileSystem } from "./filesystem";
import { joinPath, sha256Hex } from "./filesystem";
import { walkFiles } from "./traverse";
import type { ObservedFacts } from "./workspace-store";

/**
 * One included file as the source described it during a complete scan.
 *
 * Exactly the observed facts, by definition rather than by coincidence: a
 * candidate is what one observation saw, and a File row is that plus identity
 * and lifecycle. Spelling the fields again here would let the two drift.
 */
export type FileCandidate = ObservedFacts;

/**
 * The canonical absolute root a Workspace stores.
 *
 * Resolving symlinks here is what makes "one Workspace per source" true for two
 * different spellings of the same directory.
 */
export async function canonicalizeRoot(
  filesystem: WorkspaceFileSystem,
  selected: string
): Promise<string> {
  // None of these messages echo the selected path. They are mapped straight
  // onto a tRPC error, and the renderer must never learn an absolute root —
  // not as data and not as error text. The cause carries the detail for a log.
  let canonical: string;
  try {
    canonical = await filesystem.realpath(selected);
  } catch (error) {
    throw new InvalidWorkspaceInputError("Selected root does not resolve", {
      cause: error,
    });
  }

  let stats: Awaited<ReturnType<typeof filesystem.lstat>>;
  try {
    stats = await filesystem.lstat(canonical);
  } catch (error) {
    throw new InvalidWorkspaceInputError("Selected root is not readable", {
      cause: error,
    });
  }
  if (!stats.isDirectory) {
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
  filesystem: WorkspaceFileSystem,
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
  if (!stats.isDirectory) {
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
  filesystem: WorkspaceFileSystem,
  canonicalRoot: string,
  relativePath: string
): Promise<string | null> {
  let absolute = canonicalRoot;
  for (const segment of relativePath.split("/")) {
    const direct = joinPath(absolute, segment);
    // biome-ignore lint/performance/noAwaitInLoops: Operations are intentionally sequential to preserve observation and mutation order.
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
    absolute = joinPath(absolute, spelled.name);
  }
  return absolute;
}

async function exists(
  filesystem: WorkspaceFileSystem,
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
  filesystem: WorkspaceFileSystem,
  canonicalRoot: string
): Promise<readonly FileCandidate[]> {
  await verifyRoot(filesystem, canonicalRoot);
  const walked = await walkFiles(filesystem, canonicalRoot);
  const candidates: FileCandidate[] = [];

  for (const file of walked) {
    // One opened byte sequence answers both the checksum and the size. A
    // metadata-only size would let the two disagree about which moment they
    // observed.
    let bytes: Uint8Array;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Operations are intentionally sequential to preserve observation and mutation order.
      bytes = await filesystem.readFile(file.absolutePath);
    } catch (error) {
      throw new WorkspaceSourceUnavailableError(
        `Could not read ${file.relativePath}`,
        { cause: error, issue: sourceIssueFor(error) }
      );
    }
    const classification = classifyFile(file.relativePath);
    candidates.push({
      checksum: sha256Hex(bytes),
      extension: classification.extension,
      kind: classification.kind,
      mimeType: classification.mimeType,
      name: classification.name,
      path: file.relativePath,
      size: bytes.byteLength,
    });
  }

  return candidates;
}
