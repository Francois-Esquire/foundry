import type { ProposalFiles } from "~/shared/authoring";

type FileValue = string | null;

export interface ProposalConflict {
  base: FileValue;
  draft: FileValue;
  path: string;
  proposal: FileValue;
  turnId: string;
}

export interface Reconciliation {
  changes: ProposalFiles;
  conflicts: ProposalConflict[];
}

function valueAt(files: Readonly<Record<string, string>>, path: string) {
  return Object.hasOwn(files, path) ? (files[path] ?? null) : null;
}

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
