import type { JsonValue } from "@foundry/lib/json";
import {
  isGone,
  type ProcessIdentity,
  sameProcess,
  thisProcess,
} from "@foundry/lib/process-identity";
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  PubSub,
  Stream,
} from "effect";
import {
  type CausalLinks,
  type ConcurrencyPool,
  DEFAULT_POOL,
  type ExecutionPolicy,
  type Failure,
  HandlerAlreadyRegisteredError,
  HandlerNotRegisteredError,
  type HandlerRef,
  type Instant,
  InvalidPoolLimitError,
  isOpenRun,
  isTerminalJob,
  type Job,
  type JobFilter,
  type JobId,
  JobNotFoundError,
  type PoolName,
  type PoolStats,
  type QueueError,
  type QueueEvent,
  QueueRetiringError,
  type RecoverySummary,
  type Run,
  type RunFilter,
  type RunId,
  RunNotFoundError,
  type RunOutcome,
  type StoreError,
  type Wait,
  WaitAlreadySettledError,
  type WaitFilter,
  type WaitId,
  WaitNotFoundError,
  type WaitRequest,
} from "./domain";
import { nextAttemptAt } from "./retry";
import { QueueStore, type QueueWrite } from "./store/index";
import { MemoryQueueStore } from "./store/memory";

export interface RunContext {
  readonly checkpoint: JsonValue | undefined;
  readonly job: Job;
  readonly resolvedWaits: ReadonlyMap<string, JsonValue>;
  readonly run: Run;
  readonly saveCheckpoint: (
    value: JsonValue
  ) => Effect.Effect<void, QueueError>;
  readonly signal: AbortSignal;
}

export type RunHandler = (
  context: RunContext
) => Effect.Effect<RunOutcome, Failure>;

export interface SubmitJobInput {
  readonly delayMs?: number;
  readonly handler: HandlerRef;
  readonly input?: JsonValue;
  readonly links?: CausalLinks;
  readonly policy?: ExecutionPolicy;
  readonly pool?: PoolName;
}

export interface QueueOptions {
  readonly defaultLimit?: number;
  readonly identity?: ProcessIdentity;
  readonly pools?: readonly ConcurrencyPool[];
}

export interface RecoverOptions {
  readonly isOwnerGone?: (owner: ProcessIdentity) => boolean;
}

export interface QueueService {
  readonly cancel: (
    id: JobId | RunId,
    reason?: string
  ) => Effect.Effect<void, QueueError>;
  readonly cancelWait: (
    waitId: WaitId,
    reason?: string
  ) => Effect.Effect<Wait, QueueError>;
  readonly configurePool: (
    pool: ConcurrencyPool
  ) => Effect.Effect<void, InvalidPoolLimitError | StoreError>;
  readonly drain: (graceMs?: number) => Effect.Effect<void, QueueError>;
  readonly events: Stream.Stream<QueueEvent>;
  readonly getJob: (id: JobId) => Effect.Effect<Job | undefined, StoreError>;
  readonly getRun: (id: RunId) => Effect.Effect<Run | undefined, StoreError>;
  readonly getWait: (id: WaitId) => Effect.Effect<Wait | undefined, StoreError>;
  readonly listJobs: (
    filter?: JobFilter
  ) => Effect.Effect<readonly Job[], StoreError>;
  readonly listRuns: (
    filter?: RunFilter
  ) => Effect.Effect<readonly Run[], StoreError>;
  readonly listWaits: (
    filter?: WaitFilter
  ) => Effect.Effect<readonly Wait[], StoreError>;
  readonly pause: Effect.Effect<void>;
  readonly pools: Effect.Effect<readonly PoolStats[]>;
  readonly recover: (
    options?: RecoverOptions
  ) => Effect.Effect<RecoverySummary, QueueError>;
  readonly register: (
    name: string,
    handler: RunHandler
  ) => Effect.Effect<void, HandlerAlreadyRegisteredError>;
  readonly resolveWait: (
    waitId: WaitId,
    value: JsonValue
  ) => Effect.Effect<Wait, QueueError>;
  readonly resume: Effect.Effect<void>;
  readonly retire: (
    successor?: ProcessIdentity
  ) => Effect.Effect<readonly RunId[], QueueError>;
  readonly submit: (input: SubmitJobInput) => Effect.Effect<Job, QueueError>;
}

type Fact = QueueEvent extends infer Event
  ? Event extends QueueEvent
    ? Omit<Event, "at" | "id">
    : never
  : never;

interface Change {
  readonly facts: readonly Fact[];
  readonly write: QueueWrite;
}

interface Slot {
  readonly fiber: Fiber.RuntimeFiber<void>;
  readonly pool: PoolName;
}

const newId = <Prefix extends string>(prefix: Prefix) =>
  Effect.sync(() => `${prefix}-${crypto.randomUUID()}` as const);

const required =
  <Id, Found, Missing>(
    lookup: (id: Id) => Effect.Effect<Found | undefined, StoreError>,
    missing: (id: Id) => Missing
  ) =>
  (id: Id): Effect.Effect<Found, Missing | StoreError> =>
    Effect.flatMap(lookup(id), (found) =>
      found === undefined ? Effect.fail(missing(id)) : Effect.succeed(found)
    );

const isJobId = (id: JobId | RunId): id is JobId => id.startsWith("jb-");

const validLimit = (limit: number) =>
  limit === Number.POSITIVE_INFINITY || (Number.isInteger(limit) && limit >= 1);

const failureOf = (cause: Cause.Cause<Failure>): Failure =>
  Option.getOrElse(Cause.failureOption(cause), () => ({
    code: "defect",
    message: Cause.pretty(cause),
  }));

const withTimeout =
  (timeoutMs: number | undefined) =>
  (effect: Effect.Effect<RunOutcome, Failure>) =>
    timeoutMs === undefined
      ? effect
      : Effect.timeoutFail(effect, {
          duration: Duration.millis(timeoutMs),
          onTimeout: (): Failure => ({
            code: "timeout",
            message: `run exceeded ${timeoutMs}ms`,
          }),
        });

const bump = (run: Run, state: Run["state"]): Run => ({
  ...run,
  revision: run.revision + 1,
  state,
});

const availableAt = (run: Run) =>
  run.state.kind === "queued" ? run.state.availableAt : 0;

const makeQueue = (options: QueueOptions) =>
  Effect.gen(function* () {
    const store = yield* QueueStore;
    const scope = yield* Effect.scope;
    const hub = yield* Effect.acquireRelease(
      PubSub.unbounded<QueueEvent>(),
      PubSub.shutdown
    );
    const lock = yield* Effect.makeSemaphore(1);
    const wake = yield* Effect.makeLatch(false);
    const self = options.identity ?? thisProcess();
    const defaultLimit = options.defaultLimit ?? Number.POSITIVE_INFINITY;
    const handlers = new Map<string, RunHandler>();
    const pools = new Map<PoolName, ConcurrencyPool>();
    const slots = new Map<RunId, Slot>();
    const waiting = new Map<PoolName, number>();
    const admission: { paused: boolean; retiring: boolean } = {
      paused: false,
      retiring: false,
    };

    const checkPool = (pool: ConcurrencyPool) =>
      validLimit(pool.limit)
        ? Effect.succeed(pool)
        : Effect.fail(
            new InvalidPoolLimitError({ limit: pool.limit, pool: pool.name })
          );

    for (const pool of [
      ...(yield* store.listPools),
      ...(options.pools ?? []),
    ]) {
      pools.set(pool.name, yield* checkPool(pool));
    }

    const commit = (now: Instant, change: Change) =>
      Effect.gen(function* () {
        const events = change.facts.map(
          (fact): QueueEvent => ({
            ...fact,
            at: now,
            id: `ev-${crypto.randomUUID()}`,
          })
        );
        yield* store.commit({ ...change.write, events });
        yield* PubSub.publishAll(hub, events);
      }).pipe(Effect.uninterruptible);

    const requireJob = required(
      store.getJob,
      (id) => new JobNotFoundError({ id })
    );
    const requireRun = required(
      store.getRun,
      (id) => new RunNotFoundError({ id })
    );
    const requireWait = required(
      store.getWait,
      (id) => new WaitNotFoundError({ id })
    );

    const queuedRun = (
      jobId: JobId,
      attempt: number,
      pool: PoolName,
      at: Instant,
      now: Instant,
      checkpoint?: JsonValue
    ) =>
      Effect.map(
        newId("rn"),
        (id): Run => ({
          attempt,
          ...(checkpoint === undefined ? {} : { checkpoint }),
          id,
          jobId,
          pool,
          revision: 0,
          state: {
            availableAt: at,
            kind: "queued",
            owner: self,
            queuedAt: now,
          },
        })
      );

    const followUp = (job: Job, ended: Run, error: Failure, now: Instant) =>
      Effect.gen(function* () {
        const retryAt = yield* nextAttemptAt(job, ended.attempt, now);
        if (retryAt === undefined) {
          return failedJob(job, ended, error, now);
        }
        const retry = yield* queuedRun(
          job.id,
          ended.attempt + 1,
          ended.pool,
          retryAt,
          now,
          ended.checkpoint
        );
        return {
          facts: [{ run: retry, type: "RunQueued" }],
          jobs: [{ ...job, state: { kind: "pending" } }],
          runs: [retry],
        } satisfies FollowUp;
      });

    const fail = (job: Job, run: Run, error: Failure, retryable: boolean) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const next = retryable
          ? yield* followUp(job, run, error, now)
          : failedJob(job, run, error, now);
        const failed = bump(run, {
          error,
          failedAt: now,
          kind: "failed",
          retryable: next.runs.length > 0,
          startedAt: run.state.kind === "running" ? run.state.startedAt : now,
        });
        yield* commit(now, {
          facts: [{ run: failed, type: "RunFailed" }, ...next.facts],
          write: { jobs: next.jobs, runs: [failed, ...next.runs] },
        });
      });

    const interrupt = (job: Job, run: Run, reason: string) =>
      Effect.gen(function* () {
        if (run.state.kind !== "running") {
          return;
        }
        const now = yield* Clock.currentTimeMillis;
        const interrupted = bump(run, {
          interruptedAt: now,
          kind: "interrupted",
          lease: run.state.lease,
          reason,
        });
        const next = yield* followUp(
          job,
          run,
          { code: "interrupted", message: reason },
          now
        );
        yield* commit(now, {
          facts: [{ run: interrupted, type: "RunInterrupted" }, ...next.facts],
          write: { jobs: next.jobs, runs: [interrupted, ...next.runs] },
        });
      });

    const complete = (job: Job, run: Run, output: JsonValue) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const startedAt =
          run.state.kind === "running" ? run.state.startedAt : now;
        const done = bump(run, {
          completedAt: now,
          kind: "completed",
          output,
          startedAt,
        });
        const settled: Job = {
          ...job,
          state: { completedAt: now, kind: "completed", output, runId: run.id },
        };
        yield* commit(now, {
          facts: [
            { run: done, type: "RunCompleted" },
            { job: settled, type: "JobSettled" },
          ],
          write: { jobs: [settled], runs: [done] },
        });
      });

    const park = (job: Job, run: Run, request: WaitRequest) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const pending = yield* store.listWaits({
          runId: run.id,
          state: "pending",
        });
        const existing = pending.find((open) => open.key === request.key);
        const wait: Wait = existing ?? {
          ...request,
          id: yield* newId("wt"),
          revision: 0,
          runId: run.id,
          state: { createdAt: now, kind: "pending" },
        };
        const parked = bump(run, {
          kind: "parked",
          parkedAt: now,
          waitId: wait.id,
        });
        yield* commit(now, {
          facts: [
            { run: parked, type: "RunParked" },
            ...(existing === undefined
              ? [{ type: "WaitOpened", wait } as const]
              : []),
          ],
          write: {
            jobs: [
              {
                ...job,
                state: { kind: "waiting", runId: run.id, waitId: wait.id },
              },
            ],
            runs: [parked],
            waits: [wait],
          },
        });
      });

    const conclude = (
      job: Job,
      run: Run,
      exit: Exit.Exit<RunOutcome, Failure>
    ) => {
      if (Exit.isFailure(exit)) {
        return Cause.isInterruptedOnly(exit.cause)
          ? Effect.void
          : fail(job, run, failureOf(exit.cause), true);
      }
      const outcome = exit.value;
      switch (outcome.kind) {
        case "completed":
          return complete(job, run, outcome.output);
        case "parked":
          return park(job, run, outcome.wait);
        default:
          return fail(job, run, outcome.error, false);
      }
    };

    const settle = (runId: RunId, exit: Exit.Exit<RunOutcome, Failure>) =>
      Effect.gen(function* () {
        slots.delete(runId);
        const run = yield* store.getRun(runId);
        if (run?.state.kind !== "running") {
          return;
        }
        const job = yield* store.getJob(run.jobId);
        if (job !== undefined) {
          yield* conclude(job, run, exit);
        }
      });

    const cancelOpen = (run: Run, reason: string | undefined) =>
      Effect.gen(function* () {
        const job = yield* requireJob(run.jobId);
        const now = yield* Clock.currentTimeMillis;
        const wait =
          run.state.kind === "parked"
            ? yield* store.getWait(run.state.waitId)
            : undefined;
        const cancelled = {
          cancelledAt: now,
          kind: "cancelled",
          reason,
        } as const;
        const cancelledRun = bump(run, cancelled);
        const cancelledJob: Job = { ...job, state: cancelled };
        const cancelledWait: Wait | undefined =
          wait?.state.kind === "pending"
            ? { ...wait, revision: wait.revision + 1, state: cancelled }
            : undefined;
        yield* commit(now, {
          facts: [
            ...(cancelledWait
              ? [{ type: "WaitCancelled", wait: cancelledWait } as const]
              : []),
            { run: cancelledRun, type: "RunCancelled" },
            { job: cancelledJob, type: "JobSettled" },
          ],
          write: {
            jobs: [cancelledJob],
            runs: [cancelledRun],
            waits: cancelledWait ? [cancelledWait] : [],
          },
        });
        return cancelledWait;
      });

    const savedCheckpoint = (runId: RunId, value: JsonValue) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const run = yield* store.getRun(runId);
          if (run?.state.kind === "running") {
            const now = yield* Clock.currentTimeMillis;
            yield* commit(now, {
              facts: [],
              write: {
                runs: [
                  { ...run, checkpoint: value, revision: run.revision + 1 },
                ],
              },
            });
          }
        })
      );

    const contextFor = (job: Job, run: Run, signal: AbortSignal) =>
      Effect.map(
        store.listWaits({ runId: run.id, state: "resolved" }),
        (waits): RunContext => ({
          checkpoint: run.checkpoint,
          job,
          resolvedWaits: new Map(
            waits.flatMap((wait) =>
              wait.state.kind === "resolved"
                ? [[wait.key, wait.state.value] as const]
                : []
            )
          ),
          run,
          saveCheckpoint: (value) => savedCheckpoint(run.id, value),
          signal,
        })
      );

    const execute = (job: Job, run: Run, handler: RunHandler) =>
      Effect.gen(function* () {
        const controller = new AbortController();
        const exit = yield* contextFor(job, run, controller.signal).pipe(
          Effect.mapError(
            (error): Failure => ({ code: "store", message: String(error) })
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
        yield* mutate(settle(run.id, exit)).pipe(
          Effect.catchAll((error) => Effect.logWarning("settle failed", error)),
          Effect.uninterruptible
        );
      });

    const start = (job: Job, run: Run, handler: RunHandler, now: Instant) =>
      Effect.gen(function* () {
        const running = bump(run, {
          kind: "running",
          lease: { claimedAt: now, owner: self },
          startedAt: now,
        });
        const active: Job = {
          ...job,
          state: { attempt: run.attempt, kind: "active", runId: run.id },
        };
        yield* commit(now, {
          facts: [{ run: running, type: "RunStarted" }],
          write: { jobs: [active], runs: [running] },
        });
        const fiber = yield* Effect.forkIn(
          execute(active, running, handler),
          scope
        );
        slots.set(run.id, { fiber, pool: run.pool });
      }).pipe(Effect.uninterruptible);

    const poolOf = (name: PoolName): ConcurrencyPool =>
      pools.get(name) ?? { limit: defaultLimit, name, state: "active" };

    const activeIn = (name: PoolName) =>
      [...slots.values()].filter((slot) => slot.pool === name).length;

    const owned = (run: Run) =>
      run.state.kind === "queued" &&
      (run.state.owner === undefined || sameProcess(run.state.owner, self));

    const hasRoom = (pool: ConcurrencyPool) =>
      !admission.paused &&
      pool.state === "active" &&
      activeIn(pool.name) < pool.limit;

    const dispatch: Effect.Effect<Instant | undefined, StoreError> = Effect.gen(
      function* () {
        const now = yield* Clock.currentTimeMillis;
        const queued = (yield* store.listRuns({ state: "queued" }))
          .filter(owned)
          .sort((one, other) => availableAt(one) - availableAt(other));
        waiting.clear();
        let soonest: Instant | undefined;
        for (const run of queued) {
          const due = availableAt(run);
          const job = yield* store.getJob(run.jobId);
          const handler = job && handlers.get(job.handler.name);
          if (
            due <= now &&
            job !== undefined &&
            handler !== undefined &&
            hasRoom(poolOf(run.pool))
          ) {
            yield* start(job, run, handler, now);
            continue;
          }
          waiting.set(run.pool, (waiting.get(run.pool) ?? 0) + 1);
          if (due > now) {
            soonest = Math.min(soonest ?? due, due);
          }
        }
        return soonest;
      }
    );

    const mutate = <A, E>(
      effect: Effect.Effect<A, E>
    ): Effect.Effect<A, E | StoreError> =>
      lock
        .withPermits(1)(Effect.zipLeft(effect, dispatch))
        .pipe(Effect.zipLeft(wake.open));

    const nap = (soonest: Instant | undefined) =>
      Effect.gen(function* () {
        if (soonest === undefined) {
          return yield* wake.await;
        }
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.race(
          wake.await,
          Effect.sleep(Duration.millis(soonest - now))
        );
      });

    yield* Effect.gen(function* () {
      yield* wake.close;
      const soonest = yield* lock
        .withPermits(1)(dispatch)
        .pipe(
          Effect.catchAll((error) =>
            Effect.as(Effect.logWarning("dispatch failed", error), undefined)
          )
        );
      yield* nap(soonest);
    }).pipe(Effect.forever, Effect.forkScoped);

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        admission.paused = true;
      })
    );

    const openRunOf = (id: JobId | RunId) =>
      Effect.gen(function* () {
        if (!isJobId(id)) {
          const run = yield* requireRun(id);
          return isOpenRun(run.state) ? run : undefined;
        }
        const job = yield* requireJob(id);
        if (isTerminalJob(job.state)) {
          return;
        }
        const runs = yield* store.listRuns({ jobId: id });
        return runs.find((run) => isOpenRun(run.state));
      });

    const cancelRunning = (runId: RunId, reason: string | undefined) =>
      mutate(
        Effect.gen(function* () {
          const run = yield* store.getRun(runId);
          if (run?.state.kind === "running") {
            slots.delete(runId);
            yield* cancelOpen(run, reason);
          }
        })
      );

    const cancel = (id: JobId | RunId, reason?: string) =>
      Effect.gen(function* () {
        const running = yield* mutate(
          Effect.gen(function* () {
            const run = yield* openRunOf(id);
            if (run === undefined || run.state.kind === "running") {
              return run?.id;
            }
            yield* cancelOpen(run, reason);
          })
        );
        if (running === undefined) {
          return;
        }
        const slot = slots.get(running);
        if (slot !== undefined) {
          yield* Fiber.interrupt(slot.fiber);
        }
        yield* cancelRunning(running, reason);
      });

    const admit = (input: SubmitJobInput) => {
      const parent = input.links?.parentRunId;
      const { name } = input.handler;
      if (admission.retiring && (parent === undefined || !slots.has(parent))) {
        return Effect.fail(new QueueRetiringError({ handler: name }));
      }
      return handlers.has(name)
        ? Effect.void
        : Effect.fail(new HandlerNotRegisteredError({ name }));
    };

    const submit = (input: SubmitJobInput) =>
      Effect.gen(function* () {
        yield* admit(input);
        const key = input.policy?.idempotencyKey;
        const [existing] =
          key === undefined
            ? []
            : yield* store.listJobs({ idempotencyKey: key });
        if (existing !== undefined) {
          return existing;
        }
        const now = yield* Clock.currentTimeMillis;
        const job: Job = {
          createdAt: now,
          handler: input.handler,
          id: yield* newId("jb"),
          input: input.input ?? null,
          links: input.links ?? {},
          policy: input.policy ?? {},
          pool: input.pool ?? DEFAULT_POOL,
          state: { kind: "pending" },
        };
        const run = yield* queuedRun(
          job.id,
          1,
          job.pool,
          now + (input.delayMs ?? 0),
          now
        );
        yield* commit(now, {
          facts: [
            { job, type: "JobSubmitted" },
            { run, type: "RunQueued" },
          ],
          write: { jobs: [job], runs: [run] },
        });
        return job;
      });

    const resolveWait = (waitId: WaitId, value: JsonValue) =>
      Effect.gen(function* () {
        const wait = yield* requireWait(waitId);
        if (wait.state.kind !== "pending") {
          return yield* new WaitAlreadySettledError({ wait });
        }
        const now = yield* Clock.currentTimeMillis;
        const resolved: Wait = {
          ...wait,
          revision: wait.revision + 1,
          state: { kind: "resolved", resolvedAt: now, value },
        };
        const run = yield* requireRun(wait.runId);
        const job = yield* requireJob(run.jobId);
        const resumed = bump(run, {
          availableAt: now,
          kind: "queued",
          owner: self,
          queuedAt: now,
        });
        const live = run.state.kind === "parked";
        yield* commit(now, {
          facts: [
            { type: "WaitResolved", wait: resolved },
            ...(live ? [{ run: resumed, type: "RunResumed" } as const] : []),
          ],
          write: live
            ? {
                jobs: [{ ...job, state: { kind: "pending" } }],
                runs: [resumed],
                waits: [resolved],
              }
            : { waits: [resolved] },
        });
        return resolved;
      });

    const cancelWait = (waitId: WaitId, reason?: string) =>
      Effect.gen(function* () {
        const wait = yield* requireWait(waitId);
        if (wait.state.kind !== "pending") {
          return yield* new WaitAlreadySettledError({ wait });
        }
        const run = yield* requireRun(wait.runId);
        const cancelled = yield* cancelOpen(run, reason);
        return cancelled ?? wait;
      });

    const configurePool = (pool: ConcurrencyPool) =>
      Effect.gen(function* () {
        yield* checkPool(pool);
        const now = yield* Clock.currentTimeMillis;
        pools.set(pool.name, pool);
        yield* commit(now, { facts: [], write: { pools: [pool] } });
      });

    const drain = (graceMs?: number) =>
      Effect.gen(function* () {
        admission.paused = true;
        const all = Fiber.awaitAll([...slots.values()].map((s) => s.fiber));
        if (graceMs === undefined) {
          yield* all;
          return;
        }
        const finished = yield* Effect.timeoutOption(
          all,
          Duration.millis(graceMs)
        );
        if (Option.isSome(finished)) {
          return;
        }
        const remaining = [...slots.entries()];
        yield* Fiber.interruptAll(remaining.map(([, slot]) => slot.fiber));
        yield* mutate(
          Effect.forEach(remaining, ([runId]) =>
            Effect.gen(function* () {
              slots.delete(runId);
              const run = yield* requireRun(runId);
              yield* interrupt(yield* requireJob(run.jobId), run, "drained");
            })
          )
        );
      });

    const retire = (successor?: ProcessIdentity) =>
      Effect.gen(function* () {
        admission.retiring = true;
        if (successor === undefined) {
          return [];
        }
        const queued = (yield* store.listRuns({ state: "queued" })).filter(
          owned
        );
        const handedOver: Run[] = [];
        for (const run of queued) {
          const job = yield* store.getJob(run.jobId);
          if (
            job?.links.parentRunId === undefined &&
            run.state.kind === "queued"
          ) {
            handedOver.push(bump(run, { ...run.state, owner: successor }));
          }
        }
        const now = yield* Clock.currentTimeMillis;
        yield* commit(now, {
          facts: handedOver.map((run) => ({
            run,
            successor,
            type: "RunHandedOver",
          })),
          write: { runs: handedOver },
        });
        return handedOver.map((run) => run.id);
      });

    const interruptAbandoned = (gone: (owner: ProcessIdentity) => boolean) =>
      Effect.gen(function* () {
        const interrupted: RunId[] = [];
        for (const run of yield* store.listRuns({ state: "running" })) {
          if (run.state.kind !== "running") {
            continue;
          }
          const { owner } = run.state.lease;
          const abandoned = sameProcess(owner, self)
            ? !slots.has(run.id)
            : yield* Effect.sync(() => gone(owner));
          if (abandoned) {
            yield* interrupt(yield* requireJob(run.jobId), run, "owner gone");
            interrupted.push(run.id);
          }
        }
        return interrupted;
      });

    const claimOf = (
      run: Run,
      gone: (owner: ProcessIdentity) => boolean
    ): "adopt" | "mine" | "skip" => {
      const owner = run.state.kind === "queued" ? run.state.owner : self;
      if (owner === undefined) {
        return "adopt";
      }
      if (sameProcess(owner, self)) {
        return "mine";
      }
      return gone(owner) ? "adopt" : "skip";
    };

    const readmitQueued = (gone: (owner: ProcessIdentity) => boolean) =>
      Effect.gen(function* () {
        const readmitted: RunId[] = [];
        const adopted: Run[] = [];
        for (const run of yield* store.listRuns({ state: "queued" })) {
          const claim = yield* Effect.sync(() => claimOf(run, gone));
          if (claim !== "skip" && run.state.kind === "queued") {
            readmitted.push(run.id);
          }
          if (claim === "adopt" && run.state.kind === "queued") {
            adopted.push(bump(run, { ...run.state, owner: self }));
          }
        }
        const now = yield* Clock.currentTimeMillis;
        yield* commit(now, { facts: [], write: { runs: adopted } });
        return readmitted;
      });

    const recover = (recoverOptions: RecoverOptions = {}) =>
      Effect.gen(function* () {
        const gone = recoverOptions.isOwnerGone ?? isGone;
        const interrupted = yield* interruptAbandoned(gone);
        const readmitted = yield* readmitQueued(gone);
        return { interrupted, readmitted } satisfies RecoverySummary;
      });

    return Queue.of({
      cancel,
      cancelWait: (waitId, reason) => mutate(cancelWait(waitId, reason)),
      configurePool: (pool) => mutate(configurePool(pool)),
      drain,
      events: Stream.fromPubSub(hub),
      getJob: store.getJob,
      getRun: store.getRun,
      getWait: store.getWait,
      listJobs: store.listJobs,
      listRuns: store.listRuns,
      listWaits: store.listWaits,
      pause: Effect.sync(() => {
        admission.paused = true;
      }),
      pools: Effect.sync(() =>
        [
          ...new Set([
            ...pools.keys(),
            ...waiting.keys(),
            ...[...slots.values()].map((slot) => slot.pool),
          ]),
        ].map((name) => ({
          ...poolOf(name),
          active: activeIn(name),
          waiting: waiting.get(name) ?? 0,
        }))
      ),
      recover: (recoverOptions) => mutate(recover(recoverOptions)),
      register: (name, handler) =>
        handlers.has(name)
          ? Effect.fail(new HandlerAlreadyRegisteredError({ name }))
          : Effect.zipRight(
              Effect.sync(() => handlers.set(name, handler)),
              wake.open
            ),
      resolveWait: (waitId, value) => mutate(resolveWait(waitId, value)),
      resume: Effect.zipRight(
        Effect.sync(() => {
          admission.paused = false;
        }),
        wake.open
      ),
      retire: (successor) => mutate(retire(successor)),
      submit: (input) =>
        Effect.flatMap(mutate(submit(input)), (job) =>
          Effect.map(store.getJob(job.id), (latest) => latest ?? job)
        ),
    });
  });

const failedJob = (
  job: Job,
  run: Run,
  error: Failure,
  now: Instant
): FollowUp => {
  const failed: Job = {
    ...job,
    state: { error, failedAt: now, kind: "failed", lastRunId: run.id },
  };
  return {
    facts: [{ job: failed, type: "JobSettled" }],
    jobs: [failed],
    runs: [],
  };
};

interface FollowUp {
  readonly facts: readonly Fact[];
  readonly jobs: readonly Job[];
  readonly runs: readonly Run[];
}

export class Queue extends Context.Tag("@foundry/queue/Queue")<
  Queue,
  QueueService
>() {
  static readonly layer = (
    options: QueueOptions = {}
  ): Layer.Layer<Queue, InvalidPoolLimitError | StoreError, QueueStore> =>
    Layer.scoped(Queue, makeQueue(options));

  static readonly memory = (
    options: QueueOptions = {}
  ): Layer.Layer<Queue, InvalidPoolLimitError | StoreError> =>
    Queue.layer(options).pipe(Layer.provide(MemoryQueueStore));
}
