import { Deferred, Duration, Effect, Exit } from "effect";
import {
  isTerminalJob,
  type Job,
  type JobId,
  JobNotFoundError,
  JobRemovedError,
  type StoreError,
} from "./domain";
import type { QueueStoreService, QueueWrite } from "./store/index";

export type StoreChange = ReadonlySet<JobId> | "unknown";

export const changeOf = (write: QueueWrite): StoreChange =>
  new Set([
    ...(write.jobs ?? []).map((job) => job.id),
    ...(write.deleteJobs ?? []),
    ...(write.runs ?? []).map((run) => run.jobId),
  ]);

export interface StoreWatch {
  readonly from: number;
  readonly intervalMs: number;
  readonly onChange: Effect.Effect<void, StoreError>;
  readonly store: QueueStoreService;
}

export const watchStore = ({
  from,
  intervalMs,
  onChange,
  store,
}: StoreWatch) => {
  let seen = from;
  const poll = Effect.gen(function* () {
    const mark = yield* store.watermark;
    if (mark !== seen) {
      yield* onChange;
      seen = mark;
    }
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logWarning("queue store watch failed", error)
    )
  );
  return Effect.forever(
    Effect.zipRight(Effect.sleep(Duration.millis(intervalMs)), poll)
  );
};

export class JobWaiters {
  readonly #waiting = new Map<JobId, Set<() => void>>();

  register(id: JobId, wake: () => void): () => void {
    const wakes = this.#waiting.get(id) ?? new Set();
    wakes.add(wake);
    this.#waiting.set(id, wakes);
    return () => {
      wakes.delete(wake);
      if (wakes.size === 0 && this.#waiting.get(id) === wakes) {
        this.#waiting.delete(id);
      }
    };
  }

  notify(change: StoreChange): void {
    const touched =
      change === "unknown"
        ? [...this.#waiting.keys()]
        : [...change].filter((id) => this.#waiting.has(id));
    for (const id of touched) {
      const wakes = this.#waiting.get(id);
      this.#waiting.delete(id);
      for (const wake of wakes ?? []) {
        wake();
      }
    }
  }
}

type Vanished = () => JobNotFoundError | JobRemovedError;

const terminalOrWoken = (
  store: QueueStoreService,
  waiters: JobWaiters,
  id: JobId,
  vanished: Vanished
) =>
  Effect.flatMap(Deferred.make<void>(), (woken) =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        waiters.register(id, () => Deferred.unsafeDone(woken, Exit.void))
      ),
      () =>
        Effect.gen(function* () {
          const job = yield* store.getJob(id);
          if (job === undefined) {
            return yield* vanished();
          }
          if (isTerminalJob(job.state)) {
            return job;
          }
          yield* Deferred.await(woken);
        }),
      (unregister) => Effect.sync(unregister)
    )
  );

export const awaitingJob =
  (store: QueueStoreService, waiters: JobWaiters) =>
  (
    id: JobId
  ): Effect.Effect<Job, StoreError | JobNotFoundError | JobRemovedError> =>
    Effect.gen(function* () {
      let vanished: Vanished = () => new JobNotFoundError({ id });
      for (;;) {
        const job = yield* terminalOrWoken(store, waiters, id, vanished);
        if (job !== undefined) {
          return job;
        }
        vanished = () => new JobRemovedError({ id });
      }
    });
