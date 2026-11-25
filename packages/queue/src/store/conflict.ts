import type { JobId } from "../domain";
import type { ExpectedRevision, QueueWrite } from "./index";

export interface StoredRevisions {
  readonly holderOf: (idempotencyKey: string) => JobId | undefined;
  readonly runRevision: (id: string) => number | undefined;
  readonly suspensionRevision: (id: string) => number | undefined;
}

const mismatched = <Id extends string>(
  expected: readonly ExpectedRevision<Id>[] | undefined,
  revisionOf: (id: string) => number | undefined
) =>
  expected?.find(({ id, revision }) => (revisionOf(id) ?? null) !== revision)
    ?.id;

const duplicateJob = (
  jobs: QueueWrite["jobs"],
  stored: StoredRevisions
): string | undefined => {
  if (!jobs) {
    return undefined;
  }
  const seen = new Map<string, JobId>();
  for (const job of jobs) {
    const key = job.policy.idempotencyKey;
    if (key === undefined) {
      continue;
    }
    const holder = seen.get(key) ?? stored.holderOf(key);
    if (holder !== undefined && holder !== job.id) {
      return job.id;
    }
    seen.set(key, job.id);
  }
  return undefined;
};

export const conflictOf = (
  write: QueueWrite,
  stored: StoredRevisions
): string | undefined =>
  mismatched(write.expected?.runs, stored.runRevision) ??
  mismatched(write.expected?.suspensions, stored.suspensionRevision) ??
  duplicateJob(write.jobs, stored);
