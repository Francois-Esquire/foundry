import { Effect, PubSub } from "effect";
import {
  type Instant,
  JobNotFoundError,
  type QueueEvent,
  RunNotFoundError,
  type StoreError,
  SuspensionNotFoundError,
  WriteConflictError,
} from "./domain";
import type {
  ExpectedRevision,
  QueueStoreService,
  QueueWrite,
} from "./store/index";
import type { Change } from "./transitions";
import { changeOf, type JobWaiters } from "./watermark";

const CONFLICT_RETRIES = 5;

const previousRevision = <Id extends string>(record: {
  readonly id: Id;
  readonly revision: number;
}): ExpectedRevision<Id> => ({
  id: record.id,
  revision: record.revision === 0 ? null : record.revision - 1,
});

const isEmpty = (write: QueueWrite) =>
  Object.values(write).every(
    (entries) => !Array.isArray(entries) || entries.length === 0
  );

const required =
  <Id, Found, Missing>(
    lookup: (id: Id) => Effect.Effect<Found | undefined, StoreError>,
    missing: (id: Id) => Missing
  ) =>
  (id: Id): Effect.Effect<Found, Missing | StoreError> =>
    Effect.flatMap(lookup(id), (found) =>
      found === undefined ? Effect.fail(missing(id)) : Effect.succeed(found)
    );

export const newId = <Prefix extends string>(prefix: Prefix) =>
  Effect.sync(() => `${prefix}-${crypto.randomUUID()}` as const);

export const retryOnConflict = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.retry(effect, {
    times: CONFLICT_RETRIES,
    while: (error) => error instanceof WriteConflictError,
  });

export const makeLedger = (
  store: QueueStoreService,
  hub: PubSub.PubSub<QueueEvent>,
  waiters: JobWaiters
) => ({
  commit: (now: Instant, change: Change) =>
    Effect.gen(function* () {
      if (change.facts.length === 0 && isEmpty(change.write)) {
        return;
      }
      const events = change.facts.map(
        (fact): QueueEvent => ({
          ...fact,
          at: now,
          id: `ev-${crypto.randomUUID()}`,
        })
      );
      yield* store.commit({
        ...change.write,
        events,
        expected: {
          runs: [
            ...(change.write.expected?.runs ?? []),
            ...(change.write.runs ?? []).map(previousRevision),
          ],
          suspensions: [
            ...(change.write.expected?.suspensions ?? []),
            ...(change.write.suspensions ?? []).map(previousRevision),
          ],
        },
      });
      yield* PubSub.publishAll(hub, events);
      yield* Effect.sync(() => waiters.notify(changeOf(change.write)));
    }).pipe(Effect.uninterruptible),
  requireJob: required(store.getJob, (id) => new JobNotFoundError({ id })),
  requireRun: required(store.getRun, (id) => new RunNotFoundError({ id })),
  requireSuspension: required(
    store.getSuspension,
    (id) => new SuspensionNotFoundError({ id })
  ),
  store,
});

export type Ledger = ReturnType<typeof makeLedger>;
