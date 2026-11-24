import { Duration, Effect, Queue as Mailbox, PubSub } from "effect";
import {
  isTerminalJob,
  type Job,
  type JobId,
  JobNotFoundError,
  JobRemovedError,
  type StoreError,
} from "./domain";
import type { QueueStoreService } from "./store/index";

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

export const awaitingJob =
  (store: QueueStoreService, changes: PubSub.PubSub<void>) => (id: JobId) =>
    Effect.scoped(
      Effect.gen(function* () {
        const pulses = yield* PubSub.subscribe(changes);
        let job: Job | undefined = yield* store.getJob(id);
        if (job === undefined) {
          return yield* new JobNotFoundError({ id });
        }
        while (!isTerminalJob(job.state)) {
          yield* Mailbox.take(pulses);
          yield* Mailbox.takeAll(pulses);
          job = yield* store.getJob(id);
          if (job === undefined) {
            return yield* new JobRemovedError({ id });
          }
        }
        return job;
      })
    );
