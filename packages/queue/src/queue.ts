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
  ExecutionStrategy,
  Exit,
  Fiber,
  Layer,
  Option,
  PubSub,
  Scope,
  Stream,
} from "effect";
import {
  type ConcurrencyPool,
  DEFAULT_POOL,
  type ErrorShape,
  HandlerAlreadyRegisteredError,
  HandlerNotRegisteredError,
  type Instant,
  InvalidPoolLimitError,
  isOpenRun,
  isTerminalJob,
  type Job,
  type JobId,
  JobNotFoundError,
  JobNotSettledError,
  type PoolName,
  type QueueEvent,
  QueueRetiringError,
  type RecoverySummary,
  type Run,
  RunAlreadyExistsError,
  type RunId,
  RunNotFoundError,
  type RunOutcome,
  StaleSuspensionRevisionError,
  type StoreError,
  type Suspension,
  SuspensionAlreadySettledError,
  type SuspensionId,
  SuspensionNotFoundError,
  type SuspensionRequest,
} from "./domain";
import { nextAttemptAt } from "./retry";
import type {
  QueueOptions,
  QueueService,
  RecoverOptions,
  ResolveSuspensionOptions,
  RunContext,
  RunHandler,
  SubmitJobInput,
} from "./service";
import { QueueStore } from "./store/index";
import { MemoryQueueStore } from "./store/memory";
import {
  availableAt,
  bump,
  type Change,
  cancellation,
  claimOf,
  completion,
  type FollowUp,
  failedJob,
  failure,
  interruption,
  type QueuedRunInput,
  queuedRun,
  removal,
  resolution,
  retrying,
  starting,
  submission,
  suspending,
} from "./transitions";

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

const errorShapeOf = (cause: Cause.Cause<ErrorShape>): ErrorShape =>
  Option.getOrElse(Cause.failureOption(cause), () => ({
    message: Cause.pretty(cause),
    name: "defect",
  }));

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

const makeQueue = (options: QueueOptions) =>
  Effect.gen(function* () {
    const store = yield* QueueStore;
    const scope = yield* Effect.scope;
    const hub = yield* Effect.acquireRelease(
      PubSub.unbounded<QueueEvent>(),
      PubSub.shutdown
    );
    const runScope = yield* Scope.fork(scope, ExecutionStrategy.sequential);
    const lock = yield* Effect.makeSemaphore(1);
    const wake = yield* Effect.makeLatch(false);
    const self = options.identity ?? thisProcess();
    const defaultLimit = options.defaultLimit ?? 1;
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
    const requireSuspension = required(
      store.getSuspension,
      (id) => new SuspensionNotFoundError({ id })
    );

    const newRun = (
      input: Omit<QueuedRunInput, "id" | "owner">,
      chosen?: RunId
    ) =>
      Effect.map(
        chosen === undefined ? newId("rn") : Effect.succeed(chosen),
        (id) => queuedRun({ ...input, id, owner: self })
      );

    const freshRunId = (id: RunId | undefined) =>
      id === undefined
        ? Effect.void
        : Effect.flatMap(store.getRun(id), (taken) =>
            taken === undefined
              ? Effect.void
              : Effect.fail(new RunAlreadyExistsError({ id }))
          );

    const followUp = (job: Job, ended: Run, error: ErrorShape, now: Instant) =>
      Effect.gen(function* () {
        const retryAt = yield* nextAttemptAt(job, ended.attempt, now);
        if (retryAt === undefined) {
          return failedJob({ error, job, now, run: ended });
        }
        const retry = yield* newRun({
          at: retryAt,
          attempt: ended.attempt + 1,
          jobId: job.id,
          now,
          pool: ended.pool,
          ...(ended.checkpoint === undefined
            ? {}
            : { checkpoint: ended.checkpoint }),
        });
        return retrying(job, retry);
      });

    const fail = (job: Job, run: Run, error: ErrorShape, retryable: boolean) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const next: FollowUp = retryable
          ? yield* followUp(job, run, error, now)
          : failedJob({ error, job, now, run });
        yield* commit(now, failure({ error, next, now, run }));
      });

    const interrupt = (job: Job, run: Run, reason: string) =>
      Effect.gen(function* () {
        const { state } = run;
        if (state.kind !== "running") {
          return;
        }
        const now = yield* Clock.currentTimeMillis;
        const next = yield* followUp(
          job,
          run,
          { message: reason, name: "interrupted" },
          now
        );
        yield* commit(
          now,
          interruption({ next, now, reason, run: { ...run, state } })
        );
      });

    const complete = (job: Job, run: Run, output: JsonValue) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        commit(now, completion({ job, now, output, run }))
      );

    const suspend = (job: Job, run: Run, request: SuspensionRequest) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const pending = yield* store.listSuspensions({
          runId: run.id,
          state: "pending",
        });
        const existing = pending.find((open) => open.key === request.key);
        const suspension: Suspension = existing ?? {
          ...request,
          id: yield* newId("su"),
          revision: 0,
          runId: run.id,
          state: { createdAt: now, kind: "pending" },
        };
        yield* commit(
          now,
          suspending({
            job,
            now,
            opened: existing === undefined,
            run,
            suspension,
          })
        );
      });

    const conclude = (
      job: Job,
      run: Run,
      exit: Exit.Exit<RunOutcome, ErrorShape>
    ) => {
      if (Exit.isFailure(exit)) {
        return Cause.isInterruptedOnly(exit.cause)
          ? Effect.void
          : fail(job, run, errorShapeOf(exit.cause), true);
      }
      const outcome = exit.value;
      switch (outcome.kind) {
        case "complete":
          return complete(job, run, outcome.output);
        case "suspended":
          return suspend(job, run, outcome.suspension);
        default:
          return fail(job, run, outcome.error, false);
      }
    };

    const settle = (runId: RunId, exit: Exit.Exit<RunOutcome, ErrorShape>) =>
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
        const suspension =
          run.state.kind === "suspended"
            ? yield* store.getSuspension(run.state.suspensionId)
            : undefined;
        const cancelled = cancellation({ job, now, reason, run, suspension });
        yield* commit(now, cancelled.change);
        return cancelled.suspension;
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
          saveCheckpoint: (value) => savedCheckpoint(run.id, value),
          signal,
        })
      );

    const execute = (job: Job, run: Run, handler: RunHandler) =>
      Effect.gen(function* () {
        const controller = new AbortController();
        const exit = yield* contextFor(job, run, controller.signal).pipe(
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
        yield* mutate(settle(run.id, exit)).pipe(
          Effect.catchAll((error) => Effect.logWarning("settle failed", error)),
          Effect.uninterruptible
        );
      });

    const start = (job: Job, run: Run, handler: RunHandler, now: Instant) =>
      Effect.gen(function* () {
        const { active, change, running } = starting({
          job,
          now,
          owner: self,
          run,
        });
        yield* commit(now, change);
        const fiber = yield* Effect.forkIn(
          execute(active, running, handler),
          runScope
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
        yield* freshRunId(input.runId);
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
        const run = yield* newRun(
          {
            at: now + (input.delayMs ?? 0),
            attempt: 1,
            jobId: job.id,
            now,
            pool: job.pool,
          },
          input.runId
        );
        yield* commit(now, submission(job, run));
        return job;
      });

    const abandon = (id: RunId, error: ErrorShape) =>
      Effect.gen(function* () {
        const run = yield* requireRun(id);
        const open =
          run.state.kind === "queued" || run.state.kind === "running";
        if (!open || slots.has(id)) {
          return run;
        }
        yield* fail(yield* requireJob(run.jobId), run, error, false);
        return (yield* store.getRun(id)) ?? run;
      });

    const adopt = (id: RunId) =>
      Effect.gen(function* () {
        const run = yield* requireRun(id);
        if (run.state.kind !== "suspended") {
          return run;
        }
        const pending = yield* store.listSuspensions({
          runId: id,
          state: "pending",
        });
        const now = yield* Clock.currentTimeMillis;
        yield* commit(now, {
          facts: [],
          write: {
            suspensions: pending.map((suspension) => ({
              ...suspension,
              revision: suspension.revision + 1,
            })),
          },
        });
        return run;
      });

    const resolveSuspension = (
      suspensionId: SuspensionId,
      value: JsonValue,
      { expectedRevision }: ResolveSuspensionOptions = {}
    ) =>
      Effect.gen(function* () {
        const suspension = yield* requireSuspension(suspensionId);
        if (suspension.state.kind !== "pending") {
          return yield* new SuspensionAlreadySettledError({ suspension });
        }
        if (
          expectedRevision !== undefined &&
          expectedRevision !== suspension.revision
        ) {
          return yield* new StaleSuspensionRevisionError({
            expectedRevision,
            suspension,
          });
        }
        const run = yield* requireRun(suspension.runId);
        const job = yield* requireJob(run.jobId);
        const now = yield* Clock.currentTimeMillis;
        const { change, resolved } = resolution({
          job,
          now,
          owner: self,
          run,
          suspension,
          value,
        });
        yield* commit(now, change);
        return resolved;
      });

    const cancelSuspension = (suspensionId: SuspensionId, reason?: string) =>
      Effect.gen(function* () {
        const suspension = yield* requireSuspension(suspensionId);
        if (suspension.state.kind !== "pending") {
          return yield* new SuspensionAlreadySettledError({ suspension });
        }
        const run = yield* requireRun(suspension.runId);
        const cancelled = yield* cancelOpen(run, reason);
        return cancelled ?? suspension;
      });

    const removeJob = (id: JobId) =>
      Effect.gen(function* () {
        const job = yield* requireJob(id);
        if (!isTerminalJob(job.state)) {
          return yield* new JobNotSettledError({ job });
        }
        const runs = yield* store.listRuns({ jobId: id });
        const suspensions = yield* Effect.map(
          Effect.forEach(runs, (run) =>
            store.listSuspensions({ runId: run.id })
          ),
          (found) => found.flat()
        );
        const now = yield* Clock.currentTimeMillis;
        yield* commit(now, removal(job, runs, suspensions));
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
            type: "run.handed_over",
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

    const readmitQueued = (gone: (owner: ProcessIdentity) => boolean) =>
      Effect.gen(function* () {
        const readmitted: RunId[] = [];
        const adopted: Run[] = [];
        for (const run of yield* store.listRuns({ state: "queued" })) {
          const claim = yield* Effect.sync(() => claimOf(run, self, gone));
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
      abandon: (id, error) => mutate(abandon(id, error)),
      adopt: (id) => mutate(adopt(id)),
      cancel,
      cancelSuspension: (suspensionId, reason) =>
        mutate(cancelSuspension(suspensionId, reason)),
      configurePool: (pool) => mutate(configurePool(pool)),
      drain,
      events: Stream.fromPubSub(hub),
      getJob: store.getJob,
      getRun: store.getRun,
      getSuspension: store.getSuspension,
      listJobs: store.listJobs,
      listRuns: store.listRuns,
      listSuspensions: store.listSuspensions,
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
      removeJob: (id) => mutate(removeJob(id)),
      resolveSuspension: (suspensionId, value, resolveOptions) =>
        mutate(resolveSuspension(suspensionId, value, resolveOptions)),
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
