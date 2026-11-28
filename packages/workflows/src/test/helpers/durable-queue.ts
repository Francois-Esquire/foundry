import {
  type Job,
  type JobId,
  type JobState,
  Queue,
  type QueueOptions,
  type QueueService,
} from "@foundry/queue";
import { Effect, type Scope, TestContext } from "effect";

const TERMINAL: readonly JobState["kind"][] = [
  "complete",
  "failed",
  "cancelled",
];

export const withDurableQueue = <A, E>(
  body: (queue: QueueService) => Effect.Effect<A, E, Scope.Scope>,
  options: QueueOptions = {}
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(Queue, body)).pipe(
      Effect.provide(Queue.memory(options)),
      Effect.provide(TestContext.TestContext)
    )
  );

export const turn = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 1))
);

export const eventually = <A, E>(
  read: Effect.Effect<A, E>,
  ready: (value: A) => boolean
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    for (let poll = 0; poll < 500; poll += 1) {
      const value = yield* read;
      if (ready(value)) {
        return value;
      }
      yield* turn;
    }
    return yield* Effect.dieMessage("condition never held");
  });

export const settledJob = (
  queue: QueueService,
  id: JobId,
  kinds: readonly JobState["kind"][] = TERMINAL
): Effect.Effect<Job | undefined, unknown> =>
  eventually(
    queue.getJob(id),
    (job) => job !== undefined && kinds.includes(job.state.kind)
  );
