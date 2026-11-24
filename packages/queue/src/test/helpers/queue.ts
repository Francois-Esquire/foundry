import { Effect, Layer, type Scope, TestClock, TestContext } from "effect";
import type { Job, JobId, JobState } from "../../domain";
import { Queue } from "../../queue";
import type { QueueOptions, QueueService } from "../../service";
import { QueueStore, type QueueStoreService } from "../../store/index";
import { makeMemoryQueueStore } from "../../store/memory";

const TERMINAL: readonly JobState["kind"][] = [
  "complete",
  "failed",
  "cancelled",
];

export const testQueue = <A, E>(
  body: (queue: QueueService) => Effect.Effect<A, E, Scope.Scope>,
  options: QueueOptions = {}
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(Queue, body)).pipe(
      Effect.provide(Queue.memory(options)),
      Effect.provide(TestContext.TestContext)
    )
  );

export const sharedStore = (): Promise<QueueStoreService> =>
  Effect.runPromise(makeMemoryQueueStore);

export const withQueue = <A, E>(
  store: QueueStoreService,
  options: QueueOptions,
  body: (queue: QueueService) => Effect.Effect<A, E, Scope.Scope>
) =>
  Effect.scoped(Effect.flatMap(Queue, body)).pipe(
    Effect.provide(
      Queue.layer(options).pipe(Layer.provide(Layer.succeed(QueueStore, store)))
    )
  );

export const awaitJob = (
  queue: QueueService,
  id: JobId,
  kinds: readonly JobState["kind"][] = TERMINAL
): Effect.Effect<Job, unknown> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const job = yield* queue.getJob(id);
      if (job !== undefined && kinds.includes(job.state.kind)) {
        return job;
      }
      yield* Effect.yieldNow();
    }
    return yield* Effect.dieMessage(`${id} never reached ${kinds.join("|")}`);
  });

export const handler = { name: "work" } as const;

export const flush = TestClock.adjust(0);
