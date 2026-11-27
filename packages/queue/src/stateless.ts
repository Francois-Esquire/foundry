import { sameInstance } from "@foundry/lib/instance-identity";
import type { JsonValue } from "@foundry/lib/json";
import { portableProcess } from "@foundry/lib/process-identity";
import { Cause, Clock, Effect, Exit } from "effect";
import {
  DEFAULT_POOL,
  type ErrorShape,
  type Instant,
  type InvalidRetryPolicyError,
  isOpenRun,
  isTerminalJob,
  type Job,
  type JobId,
  type JobNotFoundError,
  type Lease,
  type PoolName,
  type QueueOwner,
  type Run,
  RunAlreadyExistsError,
  type RunId,
  type RunNotFoundError,
  type RunOutcome,
  type StoreError,
  WriteConflictError,
} from "./domain";
import { makeLedger, newId, retryOnConflict } from "./ledger";
import { checkRetryPolicy } from "./retry";
import type { SubmitJobInput } from "./service";
import { makeSettlement } from "./settlement";
import type { QueueStoreService } from "./store/index";
import {
  availableAt,
  cancellation,
  heldBy,
  leaseExpiry,
  queuedRun,
  starting,
  submission,
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
  readonly leaseTtlMs?: number;
  readonly owner?: QueueOwner;
  readonly pool?: PoolName;
}

export interface ClaimedRun {
  readonly job: Job;
  readonly lease: Lease;
  readonly run: Run;
}

export interface SaveRunCheckpointOptions {
  readonly leaseTtlMs?: number;
}

export interface RecoverExpiredLeasesOptions {
  readonly now?: Instant;
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

export const claimRun = (
  store: QueueStoreService,
  options: ClaimRunOptions = {}
): Effect.Effect<ClaimedRun | undefined, StoreError> => {
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
      const activeByPool = new Map<PoolName, number>();
      for (const activeRun of yield* store.listRuns({ state: "running" })) {
        activeByPool.set(
          activeRun.pool,
          (activeByPool.get(activeRun.pool) ?? 0) + 1
        );
      }
      const queued = (yield* store.listRuns({ state: "queued" }))
        .filter((run) => {
          if (run.state.kind !== "queued") {
            return false;
          }
          if (
            run.state.owner !== undefined &&
            !sameInstance(run.state.owner, owner)
          ) {
            return false;
          }
          if (
            availableAt(run) > now ||
            (options.pool !== undefined && run.pool !== options.pool)
          ) {
            return false;
          }
          const pool = pools.get(run.pool);
          if (pool?.state === "paused") {
            return false;
          }
          if (
            pool !== undefined &&
            (activeByPool.get(run.pool) ?? 0) >= pool.limit
          ) {
            return false;
          }
          return true;
        })
        .sort((one, other) => availableAt(one) - availableAt(other));
      let lastConflict: WriteConflictError | undefined;
      for (const run of queued) {
        const job = yield* store.getJob(run.jobId);
        if (
          job === undefined ||
          (allowed !== undefined && !allowed.has(job.handler.name))
        ) {
          continue;
        }
        const expiresAt = leaseExpiry(now, options.leaseTtlMs);
        const { active, change, running } = starting({
          ...(expiresAt === undefined ? {} : { expiresAt }),
          job,
          now,
          owner,
          run,
        });
        const claimed = yield* ledger.commit(now, change).pipe(
          Effect.as(true),
          Effect.catchIf(
            (error) => error instanceof WriteConflictError,
            (error) => {
              lastConflict = error;
              return Effect.succeed(false);
            }
          )
        );
        if (claimed && running.state.kind === "running") {
          return {
            job: active,
            lease: running.state.lease,
            run: running,
          } satisfies ClaimedRun;
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
    for (const run of yield* store.listRuns({ state: "running" })) {
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
