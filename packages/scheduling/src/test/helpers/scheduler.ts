import { Effect, Layer, Ref, type Scope, TestContext } from "effect";
import {
  type DispatchRequest,
  type DispatchStatus,
  ScheduleDispatch,
} from "../../dispatch";
import { DispatchError, type DispatchTarget } from "../../domain";
import {
  Scheduler,
  type SchedulerOptions,
  type SchedulerService,
} from "../../scheduler";
import { MemoryScheduleStore } from "../../store/memory";

export interface FakeDispatch {
  readonly cancelled: Ref.Ref<readonly string[]>;
  readonly failNext: Ref.Ref<number>;
  readonly layer: Layer.Layer<ScheduleDispatch>;
  readonly settle: (
    jobId: string,
    status: DispatchStatus
  ) => Effect.Effect<void>;
  readonly submitted: Ref.Ref<readonly DispatchRequest[]>;
}

const fakeDispatch = Effect.gen(function* () {
  const submitted = yield* Ref.make<readonly DispatchRequest[]>([]);
  const cancelled = yield* Ref.make<readonly string[]>([]);
  const statuses = yield* Ref.make(new Map<string, DispatchStatus>());
  const failNext = yield* Ref.make(0);
  const layer = Layer.succeed(
    ScheduleDispatch,
    ScheduleDispatch.of({
      cancel: (jobId) =>
        Effect.zipRight(
          Ref.update(cancelled, (all) => [...all, jobId]),
          Ref.update(statuses, (all) => new Map(all).set(jobId, "cancelled"))
        ),
      status: (jobId) =>
        Effect.map(Ref.get(statuses), (all) => all.get(jobId) ?? "cancelled"),
      submit: (request) =>
        Effect.gen(function* () {
          if (
            (yield* Ref.getAndUpdate(failNext, (n) => Math.max(0, n - 1))) > 0
          ) {
            return yield* new DispatchError({ cause: "dispatch down" });
          }
          const jobId = `job:${request.idempotencyKey}`;
          yield* Ref.update(submitted, (all) => [...all, request]);
          yield* Ref.update(statuses, (all) => new Map(all).set(jobId, "open"));
          return { jobId };
        }),
    })
  );
  return {
    cancelled,
    failNext,
    layer,
    settle: (jobId: string, status: DispatchStatus) =>
      Ref.update(statuses, (all) => new Map(all).set(jobId, status)),
    submitted,
  } satisfies FakeDispatch;
});

export const testScheduler = <A, E>(
  body: (
    scheduler: SchedulerService,
    dispatch: FakeDispatch
  ) => Effect.Effect<A, E, Scope.Scope>,
  options: SchedulerOptions = {}
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const dispatch = yield* fakeDispatch;
      return yield* Effect.scoped(
        Effect.flatMap(Scheduler, (scheduler) => body(scheduler, dispatch))
      ).pipe(
        Effect.provide(
          Scheduler.layer(options).pipe(
            Layer.provide(Layer.merge(dispatch.layer, MemoryScheduleStore))
          )
        )
      );
    }).pipe(Effect.provide(TestContext.TestContext))
  );

export const target: DispatchTarget = {
  handler: { name: "sync" },
  input: { full: true },
};
