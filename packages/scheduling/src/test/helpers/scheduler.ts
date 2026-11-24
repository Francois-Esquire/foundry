import {
  Clock,
  Context,
  Effect,
  Layer,
  Ref,
  type Scope,
  TestContext,
} from "effect";
import {
  type DispatchRequest,
  type DispatchStatus,
  ScheduleDispatch,
} from "../../dispatch";
import {
  DispatchError,
  type DispatchTarget,
  type Instant,
  type JobOutcome,
} from "../../domain";
import {
  Scheduler,
  type SchedulerOptions,
  type SchedulerService,
} from "../../scheduler";
import { ScheduleStore, type ScheduleStoreService } from "../../store/index";
import { MemoryScheduleStore } from "../../store/memory";

export interface FakeDispatch {
  readonly cancelled: Ref.Ref<readonly string[]>;
  readonly failNext: Ref.Ref<number>;
  readonly layer: Layer.Layer<ScheduleDispatch>;
  readonly settle: (
    jobId: string,
    outcome: JobOutcome,
    settledAt?: Instant
  ) => Effect.Effect<void>;
  readonly submitted: Ref.Ref<readonly DispatchRequest[]>;
}

export const fakeDispatch = Effect.gen(function* () {
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
          Effect.flatMap(Clock.currentTimeMillis, (settledAt) =>
            Ref.update(statuses, (all) =>
              new Map(all).set(jobId, {
                kind: "settled",
                outcome: "cancelled",
                settledAt,
              })
            )
          )
        ),
      status: (jobId) =>
        Effect.zipWith(
          Ref.get(statuses),
          Clock.currentTimeMillis,
          (all, now): DispatchStatus =>
            all.get(jobId) ?? {
              kind: "settled",
              outcome: "cancelled",
              settledAt: now,
            }
        ),
      submit: (request) =>
        Effect.gen(function* () {
          if (
            (yield* Ref.getAndUpdate(failNext, (n) => Math.max(0, n - 1))) > 0
          ) {
            return yield* new DispatchError({ cause: "dispatch down" });
          }
          const jobId = `job:${request.idempotencyKey}`;
          yield* Ref.update(submitted, (all) => [...all, request]);
          yield* Ref.update(statuses, (all) =>
            new Map(all).set(jobId, { kind: "open" })
          );
          return { jobId };
        }),
    })
  );
  return {
    cancelled,
    failNext,
    layer,
    settle: (jobId: string, outcome: JobOutcome, settledAt?: Instant) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Ref.update(statuses, (all) =>
          new Map(all).set(jobId, {
            kind: "settled",
            outcome,
            settledAt: settledAt ?? now,
          })
        )
      ),
    submitted,
  } satisfies FakeDispatch;
});

export const testScheduler = <A, E>(
  body: (
    scheduler: SchedulerService,
    dispatch: FakeDispatch
  ) => Effect.Effect<A, E, Scope.Scope | ScheduleStore>,
  options: SchedulerOptions = {},
  store: Layer.Layer<ScheduleStore> = MemoryScheduleStore
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const dispatch = yield* fakeDispatch;
      return yield* Effect.scoped(
        Effect.flatMap(Scheduler, (scheduler) => body(scheduler, dispatch))
      ).pipe(
        Effect.provide(
          Scheduler.layer(options).pipe(
            Layer.provide(dispatch.layer),
            Layer.provideMerge(store)
          )
        )
      );
    }).pipe(Effect.provide(TestContext.TestContext))
  );

export const target: DispatchTarget = {
  handler: { name: "sync" },
  input: { full: true },
};

export const startScheduler = (
  store: ScheduleStoreService,
  dispatch: FakeDispatch,
  options: SchedulerOptions = {}
): Effect.Effect<SchedulerService, never, Scope.Scope> =>
  Effect.map(
    Layer.build(
      Scheduler.layer(options).pipe(
        Layer.provide(dispatch.layer),
        Layer.provide(Layer.succeed(ScheduleStore, store))
      )
    ),
    (context) => Context.get(context, Scheduler)
  );

export const inTestContext = <A, E>(
  body: Effect.Effect<A, E, Scope.Scope>
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(body).pipe(Effect.provide(TestContext.TestContext))
  );
