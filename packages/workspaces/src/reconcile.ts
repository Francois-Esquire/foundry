import type { FileCandidate } from "./scanner";
import type { WorkspaceFileId, WorkspaceId } from "./workspace";
import type {
  ObservedFacts,
  StoredFileRecord,
  WorkspaceCatalogChange,
} from "./workspace-store";

import { OBSERVED_KEYS } from "./workspace-store";

/**
 * The exact difference between the last observation and this one.
 *
 * Pure: no filesystem, no store, no clock. Every identity decision the design
 * names — path match, confident move, ambiguous move — is decidable from these
 * two lists alone, which is what lets the adversarial cases run without a
 * temporary directory.
 */
export function diffCatalog(input: {
  readonly workspaceId: WorkspaceId;
  readonly existing: readonly StoredFileRecord[];
  readonly candidates: readonly FileCandidate[];
  readonly at: Date;
  readonly newFileId: () => WorkspaceFileId;
}): WorkspaceCatalogChange {
  const existingByPath = new Map(input.existing.map((row) => [row.path, row]));
  const matchedIds = new Set<WorkspaceFileId>();
  const updated: StoredFileRecord[] = [];
  const arrivals: FileCandidate[] = [];

  // Path first, and path wins. A candidate standing where a row already stands
  // *is* that row, even when its bytes came from somewhere else — delete
  // `a.md`, rename `b.md` to `a.md`, and `a.md`'s id survives wearing b's
  // content. That is deliberate: identity following bytes instead would turn
  // every ordinary edit into a deletion and a creation.
  for (const candidate of input.candidates) {
    const row = existingByPath.get(candidate.path);
    if (!row) {
      arrivals.push(candidate);
      continue;
    }
    matchedIds.add(row.id);
    // Only a row whose observed facts actually moved is written. An unchanged
    // File is absent from the diff entirely, so a refresh over an untouched
    // source is not a rewrite of the whole catalog.
    if (differs(row, candidate)) {
      updated.push(observed(row, candidate, input.at));
    }
  }

  const departures = input.existing.filter((row) => !matchedIds.has(row.id));
  const oldByFingerprint = groupBy(departures, fingerprintOf);
  const newByFingerprint = groupBy(arrivals, fingerprintOf);

  const moved = new Set<WorkspaceFileId>();
  const inserted: StoredFileRecord[] = [];
  for (const candidate of arrivals) {
    // Exactly one departure and exactly one arrival share the fingerprint, so
    // among files that carry bytes there is only one story the change can
    // tell. Any other group size — one to many, many to one, many to many, or
    // a file with no bytes to speak for it — is a guess, and the design
    // refuses to guess: those become deletion plus creation.
    const key = fingerprintOf(candidate);
    const olds = key === null ? [] : (oldByFingerprint.get(key) ?? []);
    const news = key === null ? [] : (newByFingerprint.get(key) ?? []);
    const origin = olds.length === 1 && news.length === 1 ? olds[0] : undefined;

    if (origin) {
      moved.add(origin.id);
      updated.push(observed(origin, candidate, input.at));
    } else {
      inserted.push(
        createFileRecord(
          input.workspaceId,
          candidate,
          input.at,
          input.newFileId()
        )
      );
    }
  }

  return {
    deletedIds: departures
      .filter((row) => !moved.has(row.id))
      .map((row) => row.id),
    inserted,
    updated,
  };
}

export function isEmptyChange(change: WorkspaceCatalogChange): boolean {
  return (
    change.inserted.length === 0 &&
    change.updated.length === 0 &&
    change.deletedIds.length === 0
  );
}

/**
 * The accepted move evidence: identical bytes at an identical length.
 *
 * Empty files are deliberately absent from this index. Every zero-byte file
 * shares one fingerprint, so a `.gitkeep` disappearing while an empty
 * `index.ts` appears would look like exactly one departure and one arrival and
 * hand the new File the old one's id. Identical bytes is only evidence of
 * identity when there are bytes.
 */
function fingerprintOf(facts: ObservedFacts): string | null {
  return facts.size === 0 ? null : `${facts.checksum}:${facts.size}`;
}

function differs(row: StoredFileRecord, candidate: FileCandidate): boolean {
  return OBSERVED_KEYS.some((key) => row[key] !== candidate[key]);
}

/** The surviving row: its id and birth are kept, every observed fact replaced. */
function observed(
  row: StoredFileRecord,
  candidate: FileCandidate,
  at: Date
): StoredFileRecord {
  return { ...row, ...candidate, updatedAt: at };
}

/** One newly catalogued File. Shared with the first scan of a new Workspace. */
export function createFileRecord(
  workspaceId: WorkspaceId,
  candidate: FileCandidate,
  at: Date,
  id: WorkspaceFileId
): StoredFileRecord {
  return { id, workspaceId, ...candidate, createdAt: at, updatedAt: at };
}

/** A null key means the value is not groupable, so it joins no group. */
function groupBy<T>(
  values: readonly T[],
  key: (value: T) => string | null
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const bucket = key(value);
    if (bucket === null) {
      continue;
    }
    const existing = grouped.get(bucket);
    if (existing) {
      existing.push(value);
    } else {
      grouped.set(bucket, [value]);
    }
  }
  return grouped;
}
