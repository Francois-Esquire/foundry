import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  isMissingPath,
  syncDirectorySync,
  writeFileAtomic,
} from "@foundry/lib/atomic-file";
import type { WorkspaceState } from "./state";

// The apply journal, `<state directory>/apply/journal.json`: the one record
// that an apply is writing, or has written, sources the saved dataset does
// not describe. It is flushed to disk before the first source write, holds
// every written file's original bytes, and is deleted only once the scan
// after the write has published, or the files are restored.

/** Bumped when `ApplyJournal` changes shape or meaning. */
const APPLY_JOURNAL_SCHEMA_VERSION = 1;

/** One file an apply writes: its original bytes and mode, and the hashes the restore guard compares. */
interface JournalFile {
  file: string;
  /** The file's permission bits before the write. */
  mode: number;
  /** The original bytes, base64. */
  original: string;
  /** SHA-256 of the original bytes. */
  originalHash: string;
  /** SHA-256 of the bytes the apply writes. */
  writtenHash: string;
}

/**
 * `writing`: the sources may hold part of a write, or all of it before its
 * checks passed; the next apply restores them. `verified`: every check
 * passed, so the sources hold the write and only the scan after it is
 * missing; the next scan publishes and then deletes the journal.
 */
type JournalPhase = "writing" | "verified";

export interface ApplyJournal {
  files: JournalFile[];
  phase: JournalPhase;
  /** The saved plan's id. */
  planId: string;
  schemaVersion: typeof APPLY_JOURNAL_SCHEMA_VERSION;
  /** The symbol, as a facet: `path#name`. */
  site: string;
  /** When the write began, ISO 8601. */
  startedAt: string;
}

export function journalPath(workspace: WorkspaceState): string {
  return join(workspace.directory, "apply", "journal.json");
}

/** The journal, or undefined when no apply is unfinished; one that cannot be read throws, naming it. */
export function readJournal(
  workspace: WorkspaceState
): ApplyJournal | undefined {
  const path = journalPath(workspace);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingPath(error)) {
      return;
    }
    throw error;
  }
  try {
    const journal = JSON.parse(text) as ApplyJournal;
    if (
      journal.schemaVersion === APPLY_JOURNAL_SCHEMA_VERSION &&
      (journal.phase === "writing" || journal.phase === "verified") &&
      Array.isArray(journal.files)
    ) {
      return journal;
    }
  } catch {
    // Reported below with the shape check.
  }
  throw new Error(
    `${path} is not an apply journal this Spyglass reads. An apply did not finish: compare the sources with Git, then delete it.`
  );
}

/**
 * Writes the journal atomically and flushes it, and its directory, to disk;
 * the state directory too when `apply/` is new, so the journal's directory
 * survives a crash as well.
 */
export async function writeJournal(
  workspace: WorkspaceState,
  journal: ApplyJournal
): Promise<void> {
  const path = journalPath(workspace);
  const created = !existsSync(dirname(path));
  await writeFileAtomic(path, `${JSON.stringify(journal, null, 2)}\n`, {
    createDirectory: true,
    fsync: true,
  });
  if (created) {
    syncDirectorySync(workspace.directory);
  }
}

export function deleteJournal(workspace: WorkspaceState): void {
  rmSync(journalPath(workspace), { force: true });
}

/** What each phase asks of the user before anything else may read or replace the dataset. */
function unfinishedApplyMessage(
  workspace: WorkspaceState,
  journal: ApplyJournal
): string {
  const where = `${journal.site} (${journalPath(workspace)})`;
  return journal.phase === "writing"
    ? `An spyglass apply of ${where} was interrupted while it wrote the sources. Run spyglass apply to restore them.`
    : `An spyglass apply of ${where} wrote and verified the sources, but the scan after it did not publish, so the saved dataset does not describe them. Run spyglass scan.`;
}

/** Refuses while any apply is unfinished, saying whether to restore or to scan; `plan` and `check` call it. */
export function refuseUnfinishedApply(workspace: WorkspaceState): void {
  const journal = readJournal(workspace);
  if (journal !== undefined) {
    throw new Error(unfinishedApplyMessage(workspace, journal));
  }
}

/**
 * Refuses an interrupted write, which apply must restore first; a scan
 * calls it. Returns a verified journal, which the scan deletes once its
 * dataset has published.
 */
export function verifiedJournal(
  workspace: WorkspaceState
): ApplyJournal | undefined {
  const journal = readJournal(workspace);
  if (journal?.phase === "writing") {
    throw new Error(unfinishedApplyMessage(workspace, journal));
  }
  return journal;
}
