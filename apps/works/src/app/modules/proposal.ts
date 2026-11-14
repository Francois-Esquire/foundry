import type { ProposalFiles } from "~/shared/authoring";

/**
 * Reconciling a chat Edit proposal into the Draft, one whole file at a time.
 * An absent file is a value (`null`) like any text. No within-file merge.
 */

type FileValue = string | null;

/** A file where both the Draft and the proposal changed it differently. */
export interface ProposalConflict {
  base: FileValue;
  draft: FileValue;
  path: string;
  proposal: FileValue;
  turnId: string;
}

export interface Reconciliation {
  /** What to write into the Draft: `null` removes a file. */
  changes: ProposalFiles;
  conflicts: ProposalConflict[];
}

function valueAt(files: Readonly<Record<string, string>>, path: string) {
  return Object.hasOwn(files, path) ? (files[path] ?? null) : null;
}

/**
 * Per path: Draft equals base → take the proposal; proposal equals base →
 * keep the Draft; Draft equals proposal → keep it; otherwise a conflict that
 * keeps both versions for comparison.
 */
export function reconcileProposal(
  turnId: string,
  draft: Readonly<Record<string, string>>,
  base: ProposalFiles,
  proposal: ProposalFiles
): Reconciliation {
  const changes: ProposalFiles = {};
  const conflicts: ProposalConflict[] = [];
  for (const [path, proposed] of Object.entries(proposal)) {
    const current = valueAt(draft, path);
    const original = base[path] ?? null;
    if (current === original) {
      if (proposed !== current) {
        changes[path] = proposed;
      }
    } else if (proposed !== original && proposed !== current) {
      conflicts.push({
        base: original,
        draft: current,
        path,
        proposal: proposed,
        turnId,
      });
    }
  }
  return { changes, conflicts };
}

/** `source` with `changes` written in: `null` removes a file. */
export function applyFiles(
  source: Readonly<Record<string, string>>,
  changes: ProposalFiles
): Record<string, string> {
  const next = { ...source };
  for (const [path, value] of Object.entries(changes)) {
    if (value === null) {
      delete next[path];
    } else {
      next[path] = value;
    }
  }
  return next;
}

/**
 * Every file the proposal would change in the Draft, held as a conflict so
 * each is chosen by hand with both versions in view (after saved source
 * moved, when the base no longer says which side changed).
 */
export function holdAll(
  turnId: string,
  draft: Readonly<Record<string, string>>,
  files: { base: ProposalFiles; proposal: ProposalFiles }
): ProposalConflict[] {
  return Object.entries(files.proposal)
    .filter(([path, proposed]) => valueAt(draft, path) !== proposed)
    .map(([path, proposed]) => ({
      base: files.base[path] ?? null,
      draft: valueAt(draft, path),
      path,
      proposal: proposed,
      turnId,
    }));
}

/** `held` with `next` in place of any conflict on the same turn and path. */
export function withConflicts(
  held: readonly ProposalConflict[],
  next: readonly ProposalConflict[]
): ProposalConflict[] {
  return [
    ...held.filter(
      (conflict) =>
        !next.some(
          (entry) =>
            entry.turnId === conflict.turnId && entry.path === conflict.path
        )
    ),
    ...next,
  ];
}
