import type { JsonValue } from "@foundry/lib/json";
import {
  Clock,
  Duration,
  Effect,
  ExecutionStrategy,
  type Exit,
  type Fiber,
  Schedule,
  Scope,
} from "effect";
import type { Capacity } from "./capacity";
import {
  type ErrorShape,
  type Instant,
  type Job,
  type Lease,
  type QueueOwner,
  type Run,
  type RunId,
  type RunOutcome,
  type StoreError,
  WriteConflictError,
} from "./domain";
import { type Ledger, retryOnConflict } from "./ledger";
import type { RunContext, RunHandler } from "./service";
import type { Settlement } from "./settlement";
import { availableAt, heldBy, leaseExpiry, starting } from "./transitions";

const LOOP_RETRY_MS = 1000;

const settleRetries = Schedule.exponential(Duration.millis(50)).pipe(
  Schedule.intersect(Schedule.recurs(6))
);

const withTimeout =
  (timeoutMs: number | undefined) =>
  (effect: Effect.Effect<RunOutcome, ErrorShape>) =>
    timeoutMs === undefined
      ? effect
      : Effect.timeoutFail(effect, {
          duration: Duration.millis(timeoutMs),
          onTimeout: (): ErrorShape => ({
            message: `run exceeded ${timeoutMs}ms`,
            name: "timeout",
          }),
        });

export interface DispatcherOptions {
  readonly capacity: Capacity;
  readonly handlers: ReadonlyMap<string, RunHandler>;
  readonly leaseTtlMs?: number;
  readonly ledger: Ledger;
  readonly self: QueueOwner;
  readonly settlement: Settlement;
}

export const makeDispatcher = ({
  capacity,
  handlers,
  leaseTtlMs,
  ledger,
  self,
  settlement,
}: DispatcherOptions) =>
  Effect.gen(function* () {
    const { commit, store } = ledger;
    const runScope = yield* Scope.fork(
      yield* Effect.scope,
      ExecutionStrategy.parallel
    );
    const lock = yield* Effect.makeSemaphore(1);
    const wake = yield* Effect.makeLatch(false);
    const locked = lock.withPermits(1);
    let target: Instant | undefined;

    const savedCheckpoint = (runId: RunId, lease: Lease, value: JsonValue) =>
      locked(
        retryOnConflict(
          Effect.gen(function* () {
            const run = yield* store.getRun(runId);
            if (heldBy(run, lease)) {
              const now = yield* Clock.currentTimeMillis;
              const expiresAt = leaseExpiry(now, leaseTtlMs);
              const state =
                expiresAt === undefined
                  ? run.state
                  : {
                      ...run.state,
                      lease: { ...run.state.lease, expiresAt },
                    };
              yield* commit(now, {
                facts: [],
                write: {
                  runs: [
                    {
                      ...run,
                      checkpoint: value,
                      revision: run.revision + 1,
                      state,
                    },
                  ],
                },
              });
            }
          })
        )
      );

    const contextFor = (
      job: Job,
      run: Run,
      lease: Lease,
      signal: AbortSignal
    ) =>
      Effect.map(
        store.listSuspensions({ runId: run.id, state: "resolved" }),
        (suspensions): RunContext => ({
          checkpoint: run.checkpoint,
          job,
          resolutions: new Map(
            suspensions.flatMap((suspension) =>
              suspension.state.kind === "resolved"
                ? [[suspension.key, suspension.state.value] as const]
                : []
            )
          ),
          run,
          saveCheckpoint: (value) => savedCheckpoint(run.id, lease, value),
          signal,
        })
      );

    const settle = (
      runId: RunId,
      lease: Lease,
      exit: Exit.Exit<RunOutcome, ErrorShape>
    ) =>
      Effect.gen(function* () {
        const run = yield* store.getRun(runId);
        const job = heldBy(run, lease)
          ? yield* store.getJob(run.jobId)
          : undefined;
        if (run !== undefined && job !== undefined) {
          yield* settlement.conclude(job, run, exit);
        }
        capacity.slots.delete(runId);
      });

    const dispatch: Effect.Effect<Instant | undefined, StoreError> =
      Effect.suspend(() =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const queued = (yield* store.listRuns({ state: "queued" }))
            .filter((run) => capacity.owns(run))
            .sort((one, other) => availableAt(one) - availableAt(other));
          capacity.waiting.clear();
          let soonest: Instant | undefined;
          for (const run of queued) {
            const due = availableAt(run);
            if (
              due <= now &&
              capacity.hasRoom(run.pool) &&
              (yield* tryStart(run, now))
            ) {
              continue;
            }
            capacity.waiting.set(
              run.pool,
              (capacity.waiting.get(run.pool) ?? 0) + 1
            );
            if (due > now) {
              soonest = Math.min(soonest ?? due, due);
            }
          }
          return soonest;
        })
      );

    const rearm = (soonest: Instant | undefined) =>
      soonest !== undefined && (target === undefined || soonest < target)
        ? wake.open
        : Effect.void;

    const mutate = <A, E>(
      effect: Effect.Effect<A, E>
    ): Effect.Effect<A, E | StoreError> =>
      locked(
        Effect.gen(function* () {
          const result = yield* retryOnConflict(effect);
          yield* dispatch.pipe(
            Effect.flatMap(rearm),
            Effect.catchAll((error) =>
              Effect.zipRight(
                Effect.logWarning("dispatch failed after mutation", error),
                wake.open
              )
            )
          );
          return result;
        })
      );

    const execute = (job: Job, run: Run, lease: Lease, handler: RunHandler) =>
      Effect.gen(function* () {
        const controller = new AbortController();
        const exit = yield* contextFor(job, run, lease, controller.signal).pipe(
          Effect.mapError(
            (error): ErrorShape => ({ message: String(error), name: "store" })
          ),
          Effect.flatMap((context) =>
            handler(context).pipe(
              Effect.onInterrupt(() => Effect.sync(() => controller.abort()))
            )
          ),
          withTimeout(job.policy.timeoutMs),
          Effect.interruptible,
          Effect.exit
        );
        yield* mutate(settle(run.id, lease, exit)).pipe(
          Effect.uninterruptible,
          Effect.tapError((error) =>
            Effect.logWarning("settle failed; retrying", error)
          ),
          Effect.retry(settleRetries),
          Effect.catchAllCause((cause) =>
            Effect.zipRight(
              Effect.logWarning(
                "settle abandoned; the run is left to recovery",
                cause
              ),
              Effect.ignore(
                mutate(
                  Effect.sync(() => {
                    capacity.slots.delete(run.id);
                  })
                )
              )
            )
          ),
          Effect.interruptible
        );
      });

    const start = (job: Job, run: Run, handler: RunHandler, now: Instant) =>
      Effect.gen(function* () {
        const expiresAt = leaseExpiry(now, leaseTtlMs);
        const { active, change, running } = starting({
          ...(expiresAt === undefined ? {} : { expiresAt }),
          job,
          now,
          owner: self,
          run,
        });
        yield* commit(now, change);
        if (running.state.kind !== "running") {
          return;
        }
        const fiber = yield* Effect.forkIn(
          execute(active, running, running.state.lease, handler),
          runScope
        );
        capacity.slots.set(run.id, {
          fiber,
          lease: running.state.lease,
          pool: run.pool,
        });
      }).pipe(Effect.uninterruptible);

    const tryStart = (run: Run, now: Instant) =>
      Effect.gen(function* () {
        const job = yield* store.getJob(run.jobId);
        const handler = job && handlers.get(job.handler.name);
        if (job === undefined || handler === undefined) {
          return false;
        }
        return yield* start(job, run, handler, now).pipe(
          Effect.as(true),
          Effect.catchIf(
            (error) => error instanceof WriteConflictError,
            () => Effect.succeed(true)
          )
        );
      });

    const releaseStaleSlots = Effect.gen(function* () {
      const stale: Fiber.RuntimeFiber<void>[] = [];
      for (const [runId, slot] of [...capacity.slots]) {
        if (!heldBy(yield* store.getRun(runId), slot.lease)) {
          capacity.slots.delete(runId);
          stale.push(slot.fiber);
        }
      }
      return stale;
    });

    const nap = (soonest: Instant | undefined) =>
      Effect.gen(function* () {
        if (soonest === undefined) {
          return yield* wake.await;
        }
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.race(
          wake.await,
          Effect.sleep(Duration.millis(Math.max(0, soonest - now)))
        );
      });

    yield* Effect.gen(function* () {
      yield* wake.close;
      const soonest = yield* locked(
        dispatch.pipe(
          Effect.catchAll((error) =>
            Effect.zipRight(
              Effect.logWarning("dispatch failed", error),
              Effect.map(Clock.currentTimeMillis, (now) => now + LOOP_RETRY_MS)
            )
          ),
          Effect.tap((next) =>
            Effect.sync(() => {
              target = next;
            })
          )
        )
      );
      yield* nap(soonest);
    }).pipe(Effect.forever, Effect.forkScoped);

    return { locked, mutate, nudge: wake.open, releaseStaleSlots };
  });
