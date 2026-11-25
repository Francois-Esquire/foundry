import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  isMissingPath,
  syncDirectorySync,
  writeFileAtomic,
} from "@foundry/lib/node/atomic-file";
import type { WorkspaceState } from "./state";

const JOURNAL_MODE = 0o600;

const APPLY_JOURNAL_SCHEMA_VERSION = 1;

interface JournalFile {
  file: string;
  mode: number;
  original: string;
  originalHash: string;
  writtenHash: string;
}

type JournalPhase = "writing" | "verified";

export interface ApplyJournal {
  files: JournalFile[];
  phase: JournalPhase;
  planId: string;
  schemaVersion: typeof APPLY_JOURNAL_SCHEMA_VERSION;
  site: string;
  startedAt: string;
}

export function journalPath(workspace: WorkspaceState): string {
  return join(workspace.directory, "apply", "journal.json");
}

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

export async function writeJournal(
  workspace: WorkspaceState,
  journal: ApplyJournal
): Promise<void> {
  const path = journalPath(workspace);
  const created = !existsSync(dirname(path));
  await writeFileAtomic(path, `${JSON.stringify(journal, null, 2)}\n`, {
    createDirectory: true,
    fsync: true,
    mode: JOURNAL_MODE,
  });
  if (created) {
    syncDirectorySync(workspace.directory);
  }
}

export function deleteJournal(workspace: WorkspaceState): void {
  rmSync(journalPath(workspace), { force: true });
}

function unfinishedApplyMessage(
  workspace: WorkspaceState,
  journal: ApplyJournal
): string {
  const where = `${journal.site} (${journalPath(workspace)})`;
  return journal.phase === "writing"
    ? `An spyglass apply of ${where} was interrupted while it wrote the sources. Run spyglass apply to restore them.`
    : `An spyglass apply of ${where} wrote and verified the sources, but the scan after it did not publish, so the saved dataset does not describe them. Run spyglass scan.`;
}

export function refuseUnfinishedApply(workspace: WorkspaceState): void {
  const journal = readJournal(workspace);
  if (journal !== undefined) {
    throw new Error(unfinishedApplyMessage(workspace, journal));
  }
}

export function verifiedJournal(
  workspace: WorkspaceState
): ApplyJournal | undefined {
  const journal = readJournal(workspace);
  if (journal?.phase === "writing") {
    throw new Error(unfinishedApplyMessage(workspace, journal));
  }
  return journal;
}
