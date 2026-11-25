import type { WorkspaceCatalogChange } from "./catalog";
import type { WorkspaceEntry, WorkspaceEntryId, WorkspaceId } from "./schema";
import type { ObservedFacts } from "./source-adapter";

export function diffCatalog(input: {
  readonly workspaceId: WorkspaceId;
  readonly existing: readonly WorkspaceEntry[];
  readonly candidates: readonly ObservedFacts[];
  readonly at: Date;
  readonly newEntryId: () => WorkspaceEntryId;
}): WorkspaceCatalogChange {
  const existingByPath = new Map(input.existing.map((row) => [row.path, row]));
  const matchedIds = new Set<WorkspaceEntryId>();
  const updated: WorkspaceEntry[] = [];
  const arrivals: ObservedFacts[] = [];

  for (const candidate of input.candidates) {
    const row = existingByPath.get(candidate.path);
    if (!row) {
      arrivals.push(candidate);
      continue;
    }
    matchedIds.add(row.id);
    if (differs(row, candidate)) {
      updated.push(observed(row, candidate, input.at));
    }
  }

  const departures = input.existing.filter((row) => !matchedIds.has(row.id));
  const oldByFingerprint = groupBy(departures, fingerprintOf);
  const newByFingerprint = groupBy(arrivals, fingerprintOf);

  const moved = new Set<WorkspaceEntryId>();
  const inserted: WorkspaceEntry[] = [];
  for (const candidate of arrivals) {
    const key = fingerprintOf(candidate);
    const olds = key === null ? [] : (oldByFingerprint.get(key) ?? []);
    const news = key === null ? [] : (newByFingerprint.get(key) ?? []);
    const origin = olds.length === 1 && news.length === 1 ? olds[0] : undefined;

    if (origin) {
      moved.add(origin.id);
      updated.push(observed(origin, candidate, input.at));
    } else {
      inserted.push(
        createEntryRecord(
          input.workspaceId,
          candidate,
          input.at,
          input.newEntryId()
        )
      );
    }
  }

  return {
    deleted: departures.filter((row) => !moved.has(row.id)),
    inserted,
    updated,
  };
}

export function isEmptyChange(change: WorkspaceCatalogChange): boolean {
  return (
    change.inserted.length === 0 &&
    change.updated.length === 0 &&
    change.deleted.length === 0
  );
}

function fingerprintOf(facts: ObservedFacts): string | null {
  return facts.type !== "file" || facts.bytes === 0
    ? null
    : `${facts.digest}:${facts.bytes}`;
}

function differs(row: WorkspaceEntry, candidate: ObservedFacts): boolean {
  if (
    row.type !== candidate.type ||
    row.path !== candidate.path ||
    row.name !== candidate.name
  ) {
    return true;
  }
  if (row.type === "file" && candidate.type === "file") {
    return (
      row.digest !== candidate.digest ||
      row.bytes !== candidate.bytes ||
      row.mime !== candidate.mime ||
      row.kind !== candidate.kind ||
      row.extension !== candidate.extension
    );
  }
  return (
    row.type === "symlink" &&
    candidate.type === "symlink" &&
    row.target !== candidate.target
  );
}

function observed(
  row: WorkspaceEntry,
  candidate: ObservedFacts,
  at: Date
): WorkspaceEntry {
  return {
    createdAt: row.createdAt,
    id: row.id,
    workspaceId: row.workspaceId,
    ...candidate,
    updatedAt: at,
  };
}

export function initialEntries(
  workspaceId: WorkspaceId,
  candidates: readonly ObservedFacts[],
  createdAt: Date
): WorkspaceEntry[] {
  return candidates.map((candidate) =>
    createEntryRecord(workspaceId, candidate, createdAt, newEntryId())
  );
}

export function newEntryId(): WorkspaceEntryId {
  return crypto.randomUUID() as WorkspaceEntryId;
}

function createEntryRecord(
  workspaceId: WorkspaceId,
  candidate: ObservedFacts,
  at: Date,
  id: WorkspaceEntryId
): WorkspaceEntry {
  return { id, workspaceId, ...candidate, createdAt: at, updatedAt: at };
}

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
