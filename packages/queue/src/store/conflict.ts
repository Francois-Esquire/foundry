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

export const conflictOf = (
  write: QueueWrite,
  stored: StoredRevisions
): string | undefined =>
  mismatched(write.expected?.runs, stored.runRevision) ??
  mismatched(write.expected?.suspensions, stored.suspensionRevision) ??
  write.jobs?.find((job) => {
    const key = job.policy.idempotencyKey;
    const holder = key === undefined ? undefined : stored.holderOf(key);
    return holder !== undefined && holder !== job.id;
  })?.id;
