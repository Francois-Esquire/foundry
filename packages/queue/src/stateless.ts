import { sameInstance } from "@foundry/lib/instance-identity";
import type { JsonValue } from "@foundry/lib/json";
import { portableProcess } from "@foundry/lib/process-identity";
import { Cause, Clock, Effect, Exit } from "effect";
import {
  type ConcurrencyPool,
  DEFAULT_POOL,
  type ErrorShape,
  type Instant,
  type InvalidRetryPolicyError,
  isOpenRun,
  isTerminalJob,
  type Job,
  type JobId,
  type JobNotFoundError,
  JobNotSettledError,
  type Lease,
  type PoolName,
  type QueueOwner,
  type Run,
  RunAlreadyExistsError,
  type RunId,
  type RunNotFoundError,
  type RunOutcome,
  StaleSuspensionRevisionError,
  type StoreError,
  type Suspension,
  SuspensionAlreadySettledError,
  type SuspensionId,
  type SuspensionNotFoundError,
  WriteConflictError,
} from "./domain";
import { type Ledger, makeLedger, newId, retryOnConflict } from "./ledger";
import { checkRetryPolicy } from "./retry";
import type { ResolveSuspensionOptions, SubmitJobInput } from "./service";
import { makeSettlement } from "./settlement";
import type { QueueStoreService } from "./store/index";
import {
  availableAt,
  bump,
  cancellation,
  heldBy,
  leaseExpiry,
  queuedRun,
  removal,
  resolution,
  starting,
  submission,
  suspensionCancellation,
} from "./transitions";

const isJobId = (id: JobId | RunId): id is JobId => id.startsWith("jb-");

const delayOf = (delayMs: number | undefined) =>
  delayMs !== undefined && Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;

const ephemeralOwner = (): QueueOwner => ({
  ...portableProcess(),
  instanceId: crypto.randomUUID(),
});

export interface EnqueueJobOptions {
  readonly owner?: QueueOwner;
}

export interface ClaimRunOptions {
  readonly handlerNames?: readonly string[];
  readonly includeResolutions?: boolean;
  readonly leaseTtlMs?: number;
  readonly owner?: QueueOwner;
  readonly pool?: PoolName;
  readonly scanLimit?: number;
}

export interface ClaimedRun {
  readonly job: Job;
  readonly lease: Lease;
  readonly resolutions: ReadonlyMap<string, JsonValue>;
  readonly run: Run;
}

export interface SaveRunCheckpointOptions {
  readonly leaseTtlMs?: number;
}

export interface RenewLeaseOptions {
  readonly leaseTtlMs: number;
}

export interface YieldRunOptions {
  readonly checkpoint?: JsonValue;
  readonly delayMs?: number;
  readonly owner?: QueueOwner;
}

export interface RecoverExpiredLeasesOptions {
  readonly limit?: number;
  readonly now?: Instant;
}

export interface NextWakeAtOptions {
  readonly pool?: PoolName;
}

const ensureFreshRunId = (store: QueueStoreService, id: RunId | undefined) =>
  id === undefined
    ? Effect.void
    : Effect.flatMap(store.getRun(id), (taken) =>
        taken === undefined
          ? Effect.void
          : Effect.fail(new RunAlreadyExistsError({ id }))
      );

const existingIdempotentJob = (
  store: QueueStoreService,
  key: string | undefined
) =>
  key === undefined
    ? Effect.succeed(undefined)
    : Effect.map(store.listJobs({ idempotencyKey: key }), ([found]) => found);

export const enqueueJob = (
  store: QueueStoreService,
  input: SubmitJobInput,
  options: EnqueueJobOptions = {}
): Effect.Effect<
  Job,
  | InvalidRetryPolicyError
  | RunAlreadyExistsError
  | StoreError
  | WriteConflictError
> => {
  const ledger = makeLedger(store);
  return Effect.gen(function* () {
    yield* checkRetryPolicy(input.policy?.retry);
    return yield* retryOnConflict(
      Effect.gen(function* () {
        const existing = yield* existingIdempotentJob(
          store,
          input.policy?.idempotencyKey
        );
        if (existing !== undefined) {
          return existing;
        }
        yield* ensureFreshRunId(store, input.runId);
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
        const run = queuedRun({
          at: now + delayOf(input.delayMs),
          attempt: 1,
          id: input.runId ?? (yield* newId("rn")),
          jobId: job.id,
          now,
          ...(options.owner === undefined ? {} : { owner: options.owner }),
          pool: job.pool,
        });
        yield* ledger.commit(now, submission(job, run));
        return job;
      })
    );
  });
};

const isClaimableRun = (
  run: Run,
  now: Instant,
  owner: QueueOwner,
  pools: ReadonlyMap<PoolName, ConcurrencyPool>,
  activeByPool: ReadonlyMap<PoolName, number>,
  poolFilter: PoolName | undefined
): boolean => {
  if (run.state.kind !== "queued") {
    return false;
  }
  if (run.state.owner !== undefined && !sameInstance(run.state.owner, owner)) {
    return false;
  }
  if (
    availableAt(run) > now ||
    (poolFilter !== undefined && run.pool !== poolFilter)
  ) {
    return false;
  }
  const pool = pools.get(run.pool);
  if (pool?.state === "paused") {
    return false;
  }
  return !(
    pool !== undefined && (activeByPool.get(run.pool) ?? 0) >= pool.limit
  );
};

const DEFAULT_CLAIM_SCAN_LIMIT = 256;
const DEFAULT_WAKE_SCAN_LIMIT = 256;

const countRunningByPool = (
  running: readonly Run[]
): ReadonlyMap<PoolName, number> => {
  const activeByPool = new Map<PoolName, number>();
  for (const activeRun of running) {
    activeByPool.set(
      activeRun.pool,
      (activeByPool.get(activeRun.pool) ?? 0) + 1
    );
  }
  return activeByPool;
};

const loadActiveCountsByPool = (
  store: QueueStoreService,
  pool?: PoolName
): Effect.Effect<ReadonlyMap<PoolName, number>, StoreError> =>
  Effect.map(
    store.listRuns({
      ...(pool === undefined ? {} : { pool }),
      state: "running",
    }),
    countRunningByPool
  );

const isPoolBlocked = (
  pool: ConcurrencyPool | undefined,
  activeByPool: ReadonlyMap<PoolName, number>
): boolean => {
  if (pool === undefined) {
    return false;
  }
  return (
    pool.state === "paused" || (activeByPool.get(pool.name) ?? 0) >= pool.limit
  );
};

const loadRunResolutions = (
  store: QueueStoreService,
  runId: RunId,
  includeResolutions: boolean | undefined
): Effect.Effect<ReadonlyMap<string, JsonValue>, StoreError> =>
  includeResolutions === false
    ? Effect.succeed(new Map<string, JsonValue>())
    : Effect.map(
        store.listSuspensions({ runId, state: "resolved" }),
        (suspensions) =>
          new Map(
            suspensions.flatMap((suspension) =>
              suspension.state.kind === "resolved"
                ? [[suspension.key, suspension.state.value] as const]
                : []
            )
          )
      );

interface ClaimAttemptContext {
  readonly allowed: ReadonlySet<string> | undefined;
  readonly includeResolutions: boolean | undefined;
  readonly leaseTtlMs: number | undefined;
  readonly ledger: ReturnType<typeof makeLedger>;
  readonly now: Instant;
  readonly owner: QueueOwner;
  readonly store: QueueStoreService;
}

const tryClaimCandidate = (
  context: ClaimAttemptContext,
  run: Run
): Effect.Effect<
  | { readonly kind: "claimed"; readonly result: ClaimedRun }
  | { readonly kind: "conflict"; readonly error: WriteConflictError }
  | { readonly kind: "skip" },
  StoreError
> =>
  Effect.gen(function* () {
    const job = yield* context.store.getJob(run.jobId);
    if (
      job === undefined ||
      (context.allowed !== undefined && !context.allowed.has(job.handler.name))
    ) {
      return { kind: "skip" as const };
    }
    const expiresAt = leaseExpiry(context.now, context.leaseTtlMs);
    const { active, change, running } = starting({
      ...(expiresAt === undefined ? {} : { expiresAt }),
      job,
      now: context.now,
      owner: context.owner,
      run,
    });
    const outcome = yield* context.ledger.commit(context.now, change).pipe(
      Effect.as({ kind: "ok" as const }),
      Effect.catchIf(
        (error) => error instanceof WriteConflictError,
        (error) => Effect.succeed({ error, kind: "conflict" as const })
      )
    );
    if (outcome.kind === "conflict") {
      return outcome;
    }
    if (running.state.kind !== "running") {
      return { kind: "skip" as const };
    }
    const resolutions = yield* loadRunResolutions(
      context.store,
      running.id,
      context.includeResolutions
    );
    return {
      kind: "claimed" as const,
      result: {
        job: active,
        lease: running.state.lease,
        resolutions,
        run: running,
      } satisfies ClaimedRun,
    };
  });

export const claimRun = (
  store: QueueStoreService,
  options: ClaimRunOptions = {}
): Effect.Effect<ClaimedRun | undefined, StoreError> => {
  const scanLimit = options.scanLimit ?? DEFAULT_CLAIM_SCAN_LIMIT;
  if (!Number.isFinite(scanLimit) || scanLimit <= 0) {
    return Effect.succeed(undefined);
  }
  const ledger = makeLedger(store);
  const owner = options.owner ?? ephemeralOwner();
  const allowed =
    options.handlerNames === undefined
      ? undefined
      : new Set(options.handlerNames);

  return retryOnConflict(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const pools = new Map(
        (yield* store.listPools).map((pool) => [pool.name, pool])
      );
      const activeByPool = yield* loadActiveCountsByPool(store, options.pool);
      if (
        options.pool !== undefined &&
        isPoolBlocked(pools.get(options.pool), activeByPool)
      ) {
        return;
      }
      const batch = yield* store.listRuns({
        availableBefore: now,
        limit: Math.max(1, Math.floor(scanLimit)),
        orderBy: "availableAt",
        ...(options.pool === undefined ? {} : { pool: options.pool }),
        state: "queued",
      });
      const candidates = batch
        .filter((run) =>
          isClaimableRun(run, now, owner, pools, activeByPool, options.pool)
        )
        .sort((one, other) => availableAt(one) - availableAt(other));
      const context: ClaimAttemptContext = {
        allowed,
        includeResolutions: options.includeResolutions,
        leaseTtlMs: options.leaseTtlMs,
        ledger,
        now,
        owner,
        store,
      };
      let lastConflict: WriteConflictError | undefined;
      for (const run of candidates) {
        const outcome = yield* tryClaimCandidate(context, run);
        if (outcome.kind === "claimed") {
          return outcome.result;
        }
        if (outcome.kind === "conflict") {
          lastConflict = outcome.error;
        }
      }
      if (lastConflict !== undefined) {
        return yield* Effect.fail(lastConflict);
      }
    })
  ).pipe(
    Effect.catchIf(
      (error) => error instanceof WriteConflictError,
      () => Effect.succeed(undefined)
    )
  );
};

export const saveRunCheckpoint = (
  store: QueueStoreService,
  runId: RunId,
  lease: Lease,
  value: JsonValue,
  options: SaveRunCheckpointOptions = {}
): Effect.Effect<boolean, StoreError | WriteConflictError> => {
  const ledger = makeLedger(store);
  return retryOnConflict(
    Effect.gen(function* () {
      const run = yield* store.getRun(runId);
      if (!heldBy(run, lease)) {
        return false;
      }
      const now = yield* Clock.currentTimeMillis;
      const expiresAt = leaseExpiry(now, options.leaseTtlMs);
      const state =
        expiresAt === undefined
          ? run.state
          : {
              ...run.state,
              lease: { ...run.state.lease, expiresAt },
            };
      yield* ledger.commit(now, {
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
      return true;
    })
  );
};

export const settleRun = (
  store: QueueStoreService,
  runId: RunId,
  lease: Lease,
  exit: Exit.Exit<RunOutcome, ErrorShape>
): Effect.Effect<boolean, StoreError | WriteConflictError> => {
  const ledger = makeLedger(store);
  const settlement = makeSettlement(ledger);
  return retryOnConflict(
    Effect.gen(function* () {
      const run = yield* store.getRun(runId);
      if (!heldBy(run, lease)) {
        return false;
      }
      const job = yield* store.getJob(run.jobId);
      if (job === undefined) {
        return false;
      }
      if (Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)) {
        yield* settlement.interrupt(job, run, "interrupted");
        return true;
      }
      yield* settlement.conclude(job, run, exit);
      return true;
    })
  );
};

export const recoverExpiredLeases = (
  store: QueueStoreService,
  options: RecoverExpiredLeasesOptions = {}
): Effect.Effect<readonly RunId[], StoreError> => {
  const ledger = makeLedger(store);
  const settlement = makeSettlement(ledger);
  return Effect.gen(function* () {
    const now = options.now ?? (yield* Clock.currentTimeMillis);
    const interrupted: RunId[] = [];
    for (const run of yield* store.listRuns({
      leaseExpiredBefore: now,
      limit: options.limit ?? 100,
      orderBy: "leaseExpiresAt",
      state: "running",
    })) {
      if (run.state.kind !== "running") {
        continue;
      }
      const { expiresAt } = run.state.lease;
      if (expiresAt === undefined || expiresAt > now) {
        continue;
      }
      const job = yield* store.getJob(run.jobId);
      if (job === undefined) {
        continue;
      }
      const done = yield* settlement.interrupt(job, run, "lease expired").pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error instanceof WriteConflictError,
          () => Effect.succeed(false)
        )
      );
      if (done) {
        interrupted.push(run.id);
      }
    }
    return interrupted;
  });
};

export const cancelJob = (
  store: QueueStoreService,
  id: JobId | RunId,
  reason?: string
): Effect.Effect<
  void,
  JobNotFoundError | RunNotFoundError | StoreError | WriteConflictError
> => {
  const ledger = makeLedger(store);
  return retryOnConflict(
    Effect.gen(function* () {
      let run: Run | undefined;
      if (isJobId(id)) {
        const job = yield* ledger.requireJob(id);
        if (!isTerminalJob(job.state)) {
          const runs = yield* store.listRuns({ jobId: id });
          run = runs.find((candidate) => isOpenRun(candidate.state));
        }
      } else {
        const found = yield* ledger.requireRun(id);
        run = isOpenRun(found.state) ? found : undefined;
      }
      if (run === undefined) {
        return;
      }
      const job = yield* ledger.requireJob(run.jobId);
      const now = yield* Clock.currentTimeMillis;
      const blocking =
        run.state.kind === "suspended"
          ? yield* store.getSuspension(run.state.suspensionId)
          : undefined;
      const cancelled = cancellation({
        job,
        now,
        reason,
        run,
        suspension: blocking,
      });
      yield* ledger.commit(now, cancelled.change);
    })
  );
};

export const resolveSuspensionOn = (
  ledger: Ledger,
  suspensionId: SuspensionId,
  value: JsonValue,
  options: ResolveSuspensionOptions = {}
): Effect.Effect<
  Suspension,
  | JobNotFoundError
  | RunNotFoundError
  | StaleSuspensionRevisionError
  | StoreError
  | SuspensionAlreadySettledError
  | SuspensionNotFoundError
  | WriteConflictError
> =>
  Effect.gen(function* () {
    const suspension = yield* ledger.requireSuspension(suspensionId);
    if (suspension.state.kind !== "pending") {
      return yield* Effect.fail(
        new SuspensionAlreadySettledError({ suspension })
      );
    }
    if (
      options.expectedRevision !== undefined &&
      options.expectedRevision !== suspension.revision
    ) {
      return yield* Effect.fail(
        new StaleSuspensionRevisionError({
          expectedRevision: options.expectedRevision,
          suspension,
        })
      );
    }
    const run = yield* ledger.requireRun(suspension.runId);
    const job = yield* ledger.requireJob(run.jobId);
    const now = yield* Clock.currentTimeMillis;
    const { change, resolved } = resolution({
      job,
      now,
      run,
      suspension,
      value,
    });
    yield* ledger.commit(now, change);
    return resolved;
  });

export const resolveSuspension = (
  store: QueueStoreService,
  suspensionId: SuspensionId,
  value: JsonValue,
  options: ResolveSuspensionOptions = {}
): Effect.Effect<
  Suspension,
  | JobNotFoundError
  | RunNotFoundError
  | StaleSuspensionRevisionError
  | StoreError
  | SuspensionAlreadySettledError
  | SuspensionNotFoundError
  | WriteConflictError
> =>
  retryOnConflict(
    resolveSuspensionOn(makeLedger(store), suspensionId, value, options)
  );

export const cancelSuspensionOn = (
  ledger: Ledger,
  suspensionId: SuspensionId,
  reason?: string
): Effect.Effect<
  Suspension,
  | JobNotFoundError
  | RunNotFoundError
  | StoreError
  | SuspensionAlreadySettledError
  | SuspensionNotFoundError
  | WriteConflictError
> =>
  Effect.gen(function* () {
    const suspension = yield* ledger.requireSuspension(suspensionId);
    if (suspension.state.kind !== "pending") {
      return yield* Effect.fail(
        new SuspensionAlreadySettledError({ suspension })
      );
    }
    const run = yield* ledger.requireRun(suspension.runId);
    const now = yield* Clock.currentTimeMillis;
    if (
      run.state.kind === "suspended" &&
      run.state.suspensionId === suspension.id
    ) {
      const job = yield* ledger.requireJob(run.jobId);
      const cancelled = cancellation({
        job,
        now,
        reason,
        run,
        suspension,
      });
      yield* ledger.commit(now, cancelled.change);
      if (cancelled.suspension !== undefined) {
        return cancelled.suspension;
      }
    }
    const cancelled = suspensionCancellation({ now, reason, suspension });
    yield* ledger.commit(now, cancelled.change);
    return cancelled.suspension;
  });

export const cancelSuspension = (
  store: QueueStoreService,
  suspensionId: SuspensionId,
  reason?: string
): Effect.Effect<
  Suspension,
  | JobNotFoundError
  | RunNotFoundError
  | StoreError
  | SuspensionAlreadySettledError
  | SuspensionNotFoundError
  | WriteConflictError
> =>
  retryOnConflict(cancelSuspensionOn(makeLedger(store), suspensionId, reason));

export const renewLease = (
  store: QueueStoreService,
  runId: RunId,
  lease: Lease,
  options: RenewLeaseOptions
): Effect.Effect<Lease | undefined, StoreError | WriteConflictError> => {
  const ledger = makeLedger(store);
  return retryOnConflict(
    Effect.gen(function* () {
      const run = yield* store.getRun(runId);
      if (!heldBy(run, lease)) {
        return;
      }
      const now = yield* Clock.currentTimeMillis;
      const expiresAt = leaseExpiry(now, options.leaseTtlMs);
      if (expiresAt === undefined) {
        return run.state.lease;
      }
      const nextLease: Lease = { ...run.state.lease, expiresAt };
      yield* ledger.commit(now, {
        facts: [],
        write: {
          runs: [
            {
              ...run,
              revision: run.revision + 1,
              state: { ...run.state, lease: nextLease },
            },
          ],
        },
      });
      return nextLease;
    })
  );
};

export const yieldRun = (
  store: QueueStoreService,
  runId: RunId,
  lease: Lease,
  options: YieldRunOptions = {}
): Effect.Effect<boolean, StoreError | WriteConflictError> => {
  const ledger = makeLedger(store);
  return retryOnConflict(
    Effect.gen(function* () {
      const run = yield* store.getRun(runId);
      if (!heldBy(run, lease)) {
        return false;
      }
      const job = yield* store.getJob(run.jobId);
      if (job === undefined) {
        return false;
      }
      const now = yield* Clock.currentTimeMillis;
      const nextRun = bump(
        options.checkpoint === undefined
          ? run
          : { ...run, checkpoint: options.checkpoint },
        {
          availableAt: now + delayOf(options.delayMs),
          kind: "queued",
          ...(options.owner === undefined ? {} : { owner: options.owner }),
          queuedAt: now,
        }
      );
      yield* ledger.commit(now, {
        facts: [{ run: nextRun, type: "run.queued" }],
        write: {
          jobs: [{ ...job, state: { kind: "pending" } }],
          runs: [nextRun],
        },
      });
      return true;
    })
  );
};

export const removeJobOn = (
  ledger: Ledger,
  id: JobId
): Effect.Effect<
  void,
  JobNotFoundError | JobNotSettledError | StoreError | WriteConflictError
> =>
  Effect.gen(function* () {
    const job = yield* ledger.requireJob(id);
    if (!isTerminalJob(job.state)) {
      return yield* Effect.fail(new JobNotSettledError({ job }));
    }
    const runs = yield* ledger.store.listRuns({ jobId: id });
    const suspensions = (yield* Effect.forEach(runs, (run) =>
      ledger.store.listSuspensions({ runId: run.id })
    )).flat();
    const now = yield* Clock.currentTimeMillis;
    yield* ledger.commit(now, removal(job, runs, suspensions));
  });

export const removeJob = (
  store: QueueStoreService,
  id: JobId
): Effect.Effect<
  void,
  JobNotFoundError | JobNotSettledError | StoreError | WriteConflictError
> => retryOnConflict(removeJobOn(makeLedger(store), id));

const soonestQueuedInPool = (
  store: QueueStoreService,
  pool?: PoolName
): Effect.Effect<Instant | undefined, StoreError> =>
  Effect.map(
    store.listRuns({
      limit: 1,
      orderBy: "availableAt",
      ...(pool === undefined ? {} : { pool }),
      state: "queued",
    }),
    ([soonest]) =>
      soonest?.state.kind === "queued" ? soonest.state.availableAt : undefined
  );

const soonestQueuedAcrossConfiguredPools = (
  store: QueueStoreService,
  pools: readonly ConcurrencyPool[],
  blockedPools: ReadonlySet<PoolName>
): Effect.Effect<Instant | undefined, StoreError> =>
  Effect.gen(function* () {
    let soonest: Instant | undefined;
    for (const pool of pools) {
      if (blockedPools.has(pool.name)) {
        continue;
      }
      const candidate = yield* soonestQueuedInPool(store, pool.name);
      if (candidate !== undefined) {
        soonest =
          soonest === undefined ? candidate : Math.min(soonest, candidate);
      }
    }
    return soonest;
  });

const soonestEligibleQueuedWakeAt = (
  store: QueueStoreService,
  pools: readonly ConcurrencyPool[],
  poolFilter: PoolName | undefined,
  blockedPools: ReadonlySet<PoolName>
): Effect.Effect<Instant | undefined, StoreError> =>
  Effect.gen(function* () {
    if (poolFilter !== undefined && blockedPools.has(poolFilter)) {
      return;
    }
    if (blockedPools.size === 0 || poolFilter !== undefined) {
      return yield* soonestQueuedInPool(store, poolFilter);
    }
    const batch = yield* store.listRuns({
      limit: DEFAULT_WAKE_SCAN_LIMIT,
      orderBy: "availableAt",
      state: "queued",
    });
    const found = batch.find(
      (run) => run.state.kind === "queued" && !blockedPools.has(run.pool)
    );
    if (found?.state.kind === "queued") {
      return found.state.availableAt;
    }
    if (batch.length < DEFAULT_WAKE_SCAN_LIMIT) {
      return;
    }
    return yield* soonestQueuedAcrossConfiguredPools(
      store,
      pools,
      blockedPools
    );
  });

const soonestLeaseExpiry = (running: readonly Run[]): Instant | undefined => {
  let soonest: Instant | undefined;
  for (const run of running) {
    if (run.state.kind !== "running") {
      continue;
    }
    const { expiresAt } = run.state.lease;
    if (expiresAt !== undefined) {
      soonest =
        soonest === undefined ? expiresAt : Math.min(soonest, expiresAt);
    }
  }
  return soonest;
};

export const nextWakeAt = (
  store: QueueStoreService,
  options: NextWakeAtOptions = {}
): Effect.Effect<Instant | undefined, StoreError> =>
  Effect.gen(function* () {
    const pools = yield* store.listPools;
    const running = yield* store.listRuns({
      ...(options.pool === undefined ? {} : { pool: options.pool }),
      state: "running",
    });
    const activeByPool = countRunningByPool(running);
    const blockedPools = new Set(
      pools
        .filter((pool) => isPoolBlocked(pool, activeByPool))
        .map((pool) => pool.name)
    );
    const queuedAt = yield* soonestEligibleQueuedWakeAt(
      store,
      pools,
      options.pool,
      blockedPools
    );
    const leaseAt = soonestLeaseExpiry(running);
    if (queuedAt === undefined) {
      return leaseAt;
    }
    if (leaseAt === undefined) {
      return queuedAt;
    }
    return Math.min(queuedAt, leaseAt);
  });
