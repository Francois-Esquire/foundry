import { closeInstance, openInstance } from "@foundry/lib/instance-identity";
import { portableProcess } from "@foundry/lib/process-identity";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  PubSub,
  Stream,
} from "effect";
import { Capacity } from "./capacity";
import { makeDispatcher } from "./dispatcher";
import {
  type ConcurrencyPool,
  DEFAULT_POOL,
  type ErrorShape,
  HandlerAlreadyRegisteredError,
  HandlerNotRegisteredError,
  InvalidPoolLimitError,
  isOpenRun,
  isTerminalJob,
  type Job,
  type JobId,
  type QueueEvent,
  QueueRetiringError,
  type Run,
  RunAlreadyExistsError,
  type RunId,
  type StoreError,
  type Suspension,
} from "./domain";
import { makeLedger, newId } from "./ledger";
import { makeRecovery } from "./recovery";
import { checkRetryPolicy } from "./retry";
import type {
  QueueOptions,
  QueueService,
  RunHandler,
  SubmitJobInput,
} from "./service";
import { makeSettlement } from "./settlement";
import {
  cancelSuspensionOn,
  removeJobOn,
  resolveSuspensionOn,
} from "./stateless";
import { QueueStore } from "./store/index";
import { MemoryQueueStore } from "./store/memory";
import { availableAt, cancellation, submission } from "./transitions";
import { awaitingJob, JobWaiters, watchStore } from "./watermark";

const isJobId = (id: JobId | RunId): id is JobId => id.startsWith("jb-");

const validLimit = (limit: number) =>
  limit === Number.POSITIVE_INFINITY || (Number.isInteger(limit) && limit >= 1);

const DEFAULT_SYNC_INTERVAL_MS = 500;

const delayOf = (delayMs: number | undefined) =>
  delayMs !== undefined && Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;

const makeQueue = (options: QueueOptions) =>
  Effect.gen(function* () {
    const store = yield* QueueStore;
    const hub = yield* Effect.acquireRelease(
      PubSub.unbounded<QueueEvent>(),
      PubSub.shutdown
    );
    const waiters = new JobWaiters();
    const self = yield* Effect.acquireRelease(
      Effect.sync(() =>
        openInstance(options.identity ?? portableProcess(), options.instanceId)
      ),
      (instance) => Effect.sync(() => closeInstance(instance))
    );
    const ledger = makeLedger(store, hub, waiters);
    const { commit, requireJob, requireRun } = ledger;
    const checkPool = (pool: ConcurrencyPool) =>
      validLimit(pool.limit)
        ? Effect.succeed(pool)
        : Effect.fail(
            new InvalidPoolLimitError({ limit: pool.limit, pool: pool.name })
          );

    const defaultPool = yield* checkPool({
      limit: options.defaultLimit ?? 1,
      name: DEFAULT_POOL,
      state: "active",
    });
    const capacity = new Capacity(defaultPool.limit, self);
    const handlers = new Map<string, RunHandler>();
    const settlement = makeSettlement(ledger);
    const recovery = makeRecovery(
      ledger,
      settlement,
      capacity,
      self,
      options.isOwnerGone
    );

    const persistedPools = new Map<string, ConcurrencyPool>();
    for (const pool of yield* store.listPools) {
      const valid = yield* checkPool(pool);
      persistedPools.set(valid.name, valid);
      capacity.pools.set(valid.name, valid);
    }
    for (const pool of options.pools ?? []) {
      capacity.pools.set(pool.name, yield* checkPool(pool));
    }

    const syncPersistedPools = Effect.map(store.listPools, (pools) => {
      for (const pool of pools) {
        if (!validLimit(pool.limit)) {
          continue;
        }
        const known = persistedPools.get(pool.name);
        if (
          known === undefined ||
          known.limit !== pool.limit ||
          known.state !== pool.state
        ) {
          persistedPools.set(pool.name, pool);
          capacity.pools.set(pool.name, pool);
        }
      }
    });

    const { locked, mutate, nudge, releaseStaleSlots } = yield* makeDispatcher({
      capacity,
      handlers,
      ...(options.leaseHeartbeatMs === undefined
        ? {}
        : { leaseHeartbeatMs: options.leaseHeartbeatMs }),
      ...(options.leaseTtlMs === undefined
        ? {}
        : { leaseTtlMs: options.leaseTtlMs }),
      ledger,
      self,
      settlement,
    });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        capacity.admission.paused = true;
      })
    );

    const syncIntervalMs = options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    if (
      store.capabilities?.watermark !== false &&
      Number.isFinite(syncIntervalMs) &&
      syncIntervalMs > 0
    ) {
      const from = yield* store.watermark;
      yield* Effect.forkScoped(
        watchStore({
          from,
          intervalMs: syncIntervalMs,
          onChange: Effect.gen(function* () {
            const stale = yield* mutate(
              Effect.zipRight(syncPersistedPools, releaseStaleSlots)
            );
            yield* Effect.sync(() => waiters.notify("unknown"));
            yield* Fiber.interruptAll(stale);
          }),
          store,
        })
      );
    }

    const freshRunId = (id: RunId | undefined) =>
      id === undefined
        ? Effect.void
        : Effect.flatMap(store.getRun(id), (taken) =>
            taken === undefined
              ? Effect.void
              : Effect.fail(new RunAlreadyExistsError({ id }))
          );

    const cancelOpen = (
      run: Run,
      reason: string | undefined,
      suspension?: Suspension
    ) =>
      Effect.gen(function* () {
        const job = yield* requireJob(run.jobId);
        const now = yield* Clock.currentTimeMillis;
        const blocking =
          suspension ??
          (run.state.kind === "suspended"
            ? yield* store.getSuspension(run.state.suspensionId)
            : undefined);
        const cancelled = cancellation({
          job,
          now,
          reason,
          run,
          suspension: blocking,
        });
        yield* commit(now, cancelled.change);
        return cancelled.suspension;
      });

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
            capacity.slots.delete(runId);
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
        const slot = capacity.slots.get(running);
        if (slot !== undefined) {
          yield* Fiber.interrupt(slot.fiber);
        }
        yield* cancelRunning(running, reason);
      });

    const admit = (input: SubmitJobInput) => {
      const parent = input.links?.parentRunId;
      const { name } = input.handler;
      if (
        capacity.admission.retiring &&
        (parent === undefined || !capacity.slots.has(parent))
      ) {
        return Effect.fail(new QueueRetiringError({ handler: name }));
      }
      return handlers.has(name)
        ? checkRetryPolicy(input.policy?.retry)
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
        const run = yield* settlement.newRun(
          {
            at: now + delayOf(input.delayMs),
            attempt: 1,
            jobId: job.id,
            now,
            ...(options.ownership === "shared" ? {} : { owner: self }),
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
        if (!open || capacity.slots.has(id)) {
          return run;
        }
        yield* settlement.fail(yield* requireJob(run.jobId), run, error, false);
        return (yield* store.getRun(id)) ?? run;
      });

    const configurePool = (pool: ConcurrencyPool) =>
      Effect.gen(function* () {
        yield* checkPool(pool);
        const now = yield* Clock.currentTimeMillis;
        yield* commit(now, { facts: [], write: { pools: [pool] } });
        persistedPools.set(pool.name, pool);
        capacity.pools.set(pool.name, pool);
      });

    const interruptActive = Effect.gen(function* () {
      const remaining = yield* locked(
        Effect.sync(() => [...capacity.slots.entries()])
      );
      yield* Fiber.interruptAll(remaining.map(([, slot]) => slot.fiber));
      yield* mutate(
        Effect.forEach(remaining, ([runId]) =>
          Effect.gen(function* () {
            capacity.slots.delete(runId);
            const run = yield* requireRun(runId);
            if (run.state.kind === "running") {
              yield* settlement.interrupt(
                yield* requireJob(run.jobId),
                run,
                "drained"
              );
            }
          })
        )
      );
    });

    const drain = (graceMs?: number) =>
      Effect.gen(function* () {
        const running = yield* locked(
          Effect.sync(() => {
            capacity.admission.paused = true;
            return [...capacity.slots.values()].map((slot) => slot.fiber);
          })
        );
        const all = Fiber.awaitAll(running);
        if (graceMs === undefined) {
          yield* all;
          return;
        }
        const drained = yield* Effect.timeoutOption(
          all,
          Duration.millis(graceMs)
        );
        if (Option.isSome(drained)) {
          return;
        }
        yield* interruptActive;
      });

    const nextQueuedAt = mutate(
      Effect.gen(function* () {
        if (capacity.slots.size > 0) {
          return "active" as const;
        }
        if (capacity.admission.paused) {
          return "idle" as const;
        }
        const queued = (yield* store.listRuns({ state: "queued" })).filter(
          (run) =>
            capacity.owns(run) && capacity.poolOf(run.pool).state === "active"
        );
        let soonest: number | undefined;
        for (const run of queued) {
          const job = yield* store.getJob(run.jobId);
          if (job === undefined || !handlers.has(job.handler.name)) {
            continue;
          }
          const due = availableAt(run);
          soonest = soonest === undefined ? due : Math.min(soonest, due);
        }
        return soonest ?? ("idle" as const);
      })
    );

    const waitForNextQueued = (nextAt: number) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const delay = Math.max(0, nextAt - now);
        if (delay > 0) {
          yield* Effect.sleep(Duration.millis(delay));
          return;
        }
        const started = yield* locked(
          Effect.sync(() => capacity.slots.size > 0)
        );
        if (!started) {
          yield* Effect.sleep(Duration.millis(10));
        }
      });

    const waitUntilIdle = Effect.gen(function* () {
      for (;;) {
        const running = yield* locked(
          Effect.sync(() =>
            [...capacity.slots.values()].map((slot) => slot.fiber)
          )
        );
        if (running.length > 0) {
          yield* Fiber.awaitAll(running);
          continue;
        }
        const nextAt = yield* nextQueuedAt;
        if (nextAt === "idle") {
          return;
        }
        if (nextAt !== "active") {
          yield* waitForNextQueued(nextAt);
        }
      }
    });

    const drainUntilIdle = (graceMs?: number) =>
      Effect.gen(function* () {
        if (graceMs === undefined) {
          yield* waitUntilIdle;
          return;
        }
        const finished = yield* Effect.timeoutOption(
          waitUntilIdle,
          Duration.millis(graceMs)
        );
        if (Option.isNone(finished)) {
          yield* interruptActive;
        }
      });

    const register = (name: string, handler: RunHandler) =>
      Effect.suspend(() =>
        handlers.has(name)
          ? Effect.fail(new HandlerAlreadyRegisteredError({ name }))
          : Effect.sync(() => {
              handlers.set(name, handler);
            })
      );

    return Queue.of({
      abandon: (id, error) => mutate(abandon(id, error)),
      awaitJob: awaitingJob(store, waiters),
      cancel,
      cancelSuspension: (suspensionId, reason) =>
        mutate(cancelSuspensionOn(ledger, suspensionId, reason)),
      configurePool: (pool) => mutate(configurePool(pool)),
      drain,
      drainUntilIdle,
      getJob: store.getJob,
      getRun: store.getRun,
      getSuspension: store.getSuspension,
      listJobs: store.listJobs,
      listRuns: store.listRuns,
      listSuspensions: store.listSuspensions,
      pause: locked(
        Effect.sync(() => {
          capacity.admission.paused = true;
        })
      ),
      pools: Effect.sync(() => capacity.stats()),
      recover: (recoverOptions) =>
        Effect.gen(function* () {
          const recovered = yield* mutate(
            Effect.gen(function* () {
              const summary = yield* recovery.recover(recoverOptions);
              const stale = yield* releaseStaleSlots;
              return { stale, summary };
            })
          );
          yield* Fiber.interruptAll(recovered.stale);
          return recovered.summary;
        }),
      register: (name, handler) =>
        Effect.zipLeft(locked(register(name, handler)), nudge),
      removeJob: (id) => mutate(removeJobOn(ledger, id)),
      resolveSuspension: (suspensionId, value, resolveOptions) =>
        mutate(
          resolveSuspensionOn(ledger, suspensionId, value, resolveOptions)
        ),
      resume: Effect.zipLeft(
        locked(
          Effect.sync(() => {
            capacity.admission.paused = false;
          })
        ),
        nudge
      ),
      retire: (successor) => mutate(recovery.retire(successor)),
      submit: (input) =>
        Effect.flatMap(mutate(submit(input)), (job) =>
          Effect.map(store.getJob(job.id), (latest) => latest ?? job)
        ),
      subscribe: Stream.fromPubSub(hub, { scoped: true }),
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
