import {
  ExecutionConflictRetriesExhaustedError,
  JobAlreadySettledError,
  JobAttemptAlreadyActiveError,
  JobNotFoundError,
  RecordAlreadyExistsError,
  RecordInUseError,
  RunAlreadySettledError,
  RunNotFoundError,
  RunNotSuspendedError,
  StaleSuspensionRevisionError,
  SuspensionAlreadySettledError,
  SuspensionNotFoundError,
  SuspensionOccurrenceMismatchError,
} from "./errors";
import type {
  DefinitionReference,
  JobRecord,
  JobStatus,
  JsonValue,
  RunFrame,
  RunFramePayload,
  RunLinks,
  RunRecord,
  SuspensionRecord,
} from "./execution-records";
import {
  decodeJobRecord,
  decodeRunRecord,
  decodeSuspensionRecord,
} from "./execution-records";
import type {
  CreateJobInput,
  CreateJobRunInput,
  CreateRunInput,
  CreateSuspensionInput,
  EnsureQueueInput,
  ExecutionCommands,
  ExecutionRepository,
  JobCancellation,
  JobCancellationCommit,
  JobCancellationTransaction,
  JobQuery,
  JobRunClaim,
  JobRunClaimCommit,
  JobRunClaimOutcome,
  JobRunClaimTransaction,
  Page,
  QueueRecord,
  RecoverableRun,
  RepositoryCommitOutcome,
  RunPage,
  RunQuery,
  SettleSuspensionInput,
  SuspensionCancellation,
  SuspensionCancellationCommit,
  SuspensionCancellationTransaction,
  SuspensionParking,
  SuspensionParkingCommit,
  SuspensionParkingTransaction,
  SuspensionQuery,
  SuspensionSettlement,
  SuspensionSettlementCommit,
  SuspensionSettlementTransaction,
  UpdateJobInput,
  UpdateQueueInput,
  UpdateRunInput,
} from "./execution-repository";
import { createExtensions, mergeExtensions } from "./extensions";
import { rowToRecoverable } from "./metadata-codec";
import type {
  AppendRunFrameInput,
  ClaimRunEffectInput,
  FrameRun,
  RunFramePageQuery,
  RunJournal,
} from "./run-journal";
import {
  decodeRunFrame,
  decodeRunFrameSequence,
  isRunEffectClaim,
  runEffectClaimPayload,
} from "./run-journal";
import type { WorkflowSnapshot } from "./snapshot";
import type { RunStatus } from "./types";

function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

const EXECUTION_METADATA_KEY = "workflows.execution";
const MAX_AGGREGATE_COMMIT_ATTEMPTS = 8;
const INTERNAL_PAGE_LIMIT = 200;

interface PreparedAggregateCommit<Result, Commit> {
  readonly commit?: Commit;
  readonly result: Result;
}

type AggregateCommitOutcome = JobRunClaimOutcome | RepositoryCommitOutcome;

async function retryAggregateCommit<
  Result,
  Commit,
  Outcome extends AggregateCommitOutcome,
>(
  operation: string,
  prepare: () => Promise<PreparedAggregateCommit<Result, Commit>>,
  submit: (commit: Commit) => Promise<Outcome>,
  project: (result: Result, outcome: Outcome) => Result
): Promise<Result> {
  for (let attempt = 1; attempt <= MAX_AGGREGATE_COMMIT_ATTEMPTS; attempt++) {
    const prepared = await prepare();
    if (prepared.commit === undefined) {
      return prepared.result;
    }

    const outcome = await submit(prepared.commit);
    if (outcome.status === "conflict") {
      if (attempt === MAX_AGGREGATE_COMMIT_ATTEMPTS) {
        throw new ExecutionConflictRetriesExhaustedError(operation, attempt);
      }
      continue;
    }
    return project(prepared.result, outcome);
  }

  throw new ExecutionConflictRetriesExhaustedError(
    operation,
    MAX_AGGREGATE_COMMIT_ATTEMPTS
  );
}

async function collectPages<T>(
  list: (page: { limit: number; offset: number }) => Promise<Page<T>>
): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await list({ limit: INTERNAL_PAGE_LIMIT, offset });
    items.push(...page.items);
    if (page.nextOffset === null) {
      return items;
    }
    offset = page.nextOffset;
  }
}

function pageValues<T>(
  values: readonly T[],
  query: { readonly limit?: number; readonly offset?: number },
  fallback: number
): Page<T> {
  const limit = query.limit ?? fallback;
  const offset = query.offset ?? 0;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 200) {
    throw new Error("[execution] page limit must be an integer from 1 to 200");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("[execution] page offset must be a non-negative integer");
  }
  const items = values.slice(offset, offset + limit).map(cloneValue);
  const hasMore = values.length > offset + items.length;
  return {
    hasMore,
    items,
    limit,
    nextOffset: hasMore ? offset + items.length : null,
    offset,
  };
}

export type {
  DefinitionReference,
  JobLinks,
  JobRecord,
  JobStatus,
  JsonValue,
  RunFrame,
  RunFramePayload,
  RunLinks,
  RunRecord,
  RunTimestamps,
  SuspensionRecord,
  SuspensionStatus,
} from "./execution-records";
export {
  DefinitionReferenceSchema,
  decodeJobRecord,
  decodeRunRecord,
  decodeSuspensionRecord,
  isJsonValue,
  JobLinksSchema,
  JobRecordSchema,
  JobStatusSchema,
  JsonValueSchema,
  RunFramePayloadSchema,
  RunFrameSchema,
  RunLinksSchema,
  RunRecordSchema,
  RunStatusSchema,
  SuspensionRecordSchema,
  SuspensionStatusSchema,
} from "./execution-records";
export type {
  CreateJobInput,
  CreateJobRunInput,
  CreateRunInput,
  CreateSuspensionInput,
  DirectRunLinks,
  EnsureQueueInput,
  ExecutionRepository,
  JobCancellation,
  JobCancellationTransaction,
  JobQuery,
  JobRunClaim,
  JobRunClaimOutcome,
  JobRunClaimTransaction,
  Page,
  PageQuery,
  QueueRecord,
  RecoverableRun,
  RunPage,
  RunQuery,
  SettleSuspensionInput,
  SuspensionCancellation,
  SuspensionCancellationTransaction,
  SuspensionParking,
  SuspensionParkingTransaction,
  SuspensionQuery,
  SuspensionSettlement,
  SuspensionSettlementOutcome,
  SuspensionSettlementTransaction,
  UpdateJobInput,
  UpdateQueueInput,
  UpdateRunInput,
} from "./execution-repository";
export type { Extensions, ExtensionValue } from "./extensions";
export {
  createExtensions,
  extensionsFromUnknown,
  mergeExtensions,
} from "./extensions";
export type {
  AppendRunFrameInput,
  ClaimRunEffectInput,
  FrameRun,
  RunFramePageQuery,
  RunJournal,
} from "./run-journal";
export {
  decodeRunFrame,
  decodeRunFrameSequence,
  decodeRunFrames,
} from "./run-journal";
export type { OrchestratorStoreSnapshot } from "./store-snapshot";
export {
  ORCHESTRATOR_STORE_SNAPSHOT_VERSION,
  OrchestratorStoreSnapshotSchema,
  validateOrchestratorStoreSnapshot,
} from "./store-snapshot";

export interface OrchestratorStore extends ExecutionCommands, RunJournal {}

// recovery extension — present only on durable stores (and InMemory, for in-process tests)
/**
 * Storage-independent execution coordinator behind the legacy Store interface.
 * Durable implementations supply persistence hooks; this module owns creation
 * defaults, lifecycle policy, patch semantics, and query matching.
 */
export abstract class AbstractOrchestratorStore implements OrchestratorStore {
  readonly #mutationTails = new Map<string, Promise<void>>();

  async createJob(input: CreateJobInput): Promise<JobRecord> {
    const id = input.id ?? generateId("jb");
    return this.withMutationLock(`job:${id}`, async () => {
      if (await this.readJob(id)) {
        throw new RecordAlreadyExistsError("job", id);
      }

      const record = decodeJobRecord({
        definition: input.definition,
        id,
        input: input.input,
        links: input.links ?? {},
        status: "pending",
        timestamps: {
          cancelledAt: null,
          completedAt: null,
          createdAt: Date.now(),
          failedAt: null,
        },
      });
      await this.writeJob(record);
      return cloneValue(record);
    });
  }

  getJob(id: string): Promise<JobRecord | null> {
    return this.readJob(id);
  }

  async updateJob(
    id: string,
    patch: UpdateJobInput
  ): Promise<JobRecord | null> {
    return this.withMutationLock(`job:${id}`, async () => {
      const existing = await this.readJob(id);
      if (!existing) {
        return null;
      }
      if (
        isTerminalJobStatus(existing.status) &&
        patch.status !== undefined &&
        patch.status !== existing.status
      ) {
        return cloneValue(existing);
      }

      const updated = decodeJobRecord({
        ...existing,
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.timestamps === undefined
          ? {}
          : { timestamps: { ...existing.timestamps, ...patch.timestamps } }),
      });
      await this.writeJob(updated);
      return cloneValue(updated);
    });
  }

  listJobs(query: JobQuery = {}): Promise<Page<JobRecord>> {
    return this.queryJobs(query);
  }

  async deleteJob(id: string): Promise<void> {
    const linkedRuns = await this.listRuns({ links: { jobId: id } });
    if (linkedRuns.items.length > 0) {
      throw new RecordInUseError("job", id);
    }
    await this.removeJob(id);
  }

  async cancelJob(id: string): Promise<JobCancellation> {
    return this.withJobCancellationTransaction(id, async (transaction) => {
      const job = await transaction.readJob();
      if (!job) {
        throw new JobNotFoundError(id);
      }
      if (isTerminalJobStatus(job.status)) {
        throw new JobAlreadySettledError(id);
      }
      const runs = (await transaction.readRuns()).map(hydrateRunRecord);
      const jobRuns = runs.filter((run) => run.links?.jobId === id);
      const active =
        jobRuns.find((run) => isNonTerminalRunStatus(run.status)) ?? null;
      if (active === null && jobRuns.some((run) => run.status === "complete")) {
        throw new JobAlreadySettledError(id);
      }
      const pending = active
        ? (await transaction.readSuspensions())
            .filter(
              (record) =>
                record.runId === active.id && record.status === "pending"
            )
            .sort((left, right) => left.id.localeCompare(right.id))
        : [];
      const cancelledAt = Date.now();
      const nextJob = decodeJobRecord({
        ...job,
        status: "cancelled",
        timestamps: { ...job.timestamps, cancelledAt },
      });
      const nextRun = active
        ? normalizeRunRecord(applyRunPatch(active, { status: "cancelled" }))
        : null;
      const cancelledSuspensions = pending.map((record) =>
        cancelSuspensionRecord(record, cancelledAt)
      );
      await transaction.write({
        nextJob,
        nextRun,
        nextSuspensions: cancelledSuspensions,
        previousJob: job,
        previousRun: active,
        previousSuspensions: pending,
      });
      return {
        job: cloneValue(nextJob),
        run: nextRun ? cloneRun(nextRun) : null,
        suspensions: cancelledSuspensions.map((record) => cloneValue(record)),
      };
    });
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const id = input.id ?? generateId("rn");
    return this.withMutationLock(`run:${id}`, async () => {
      if (await this.readRun(id)) {
        throw new RecordAlreadyExistsError("run", id);
      }
      const unsafeLinks = input.links as RunLinks | undefined;
      if (unsafeLinks?.jobId !== undefined) {
        throw new Error(
          "Job-linked Runs must be created through claimJobRun()"
        );
      }
      const record = buildRunRecord(id, input);
      await this.writeRun(record);
      return cloneRun(record);
    });
  }

  async claimJobRun(
    jobId: string,
    input: CreateJobRunInput
  ): Promise<JobRunClaim> {
    const outcome = await this.withJobRunClaimTransaction(
      jobId,
      async (transaction) => {
        const job = await transaction.readJob();
        if (!job) {
          throw new JobNotFoundError(jobId);
        }
        if (
          job.status === "complete" ||
          job.status === "failed" ||
          job.status === "cancelled"
        ) {
          throw new JobAlreadySettledError(jobId);
        }

        const linkedRuns = (await transaction.readRuns())
          .map(hydrateRunRecord)
          .filter((run) => run.links?.jobId === jobId);
        const active = linkedRuns.find((run) =>
          ["queued", "running", "suspended"].includes(run.status)
        );
        if (active) {
          throw new JobAttemptAlreadyActiveError(jobId, active.id);
        }
        if (linkedRuns.some((run) => run.status === "complete")) {
          const settled = decodeJobRecord({
            ...job,
            status: "complete",
            timestamps: {
              ...job.timestamps,
              completedAt: Date.now(),
            },
          });
          await transaction.writeJob(settled);
          return { job: cloneValue(settled), status: "settled" };
        }

        const runId = input.id ?? generateId("rn");
        return this.withMutationLock(`run:${runId}`, async () => {
          if (await transaction.readRun(runId)) {
            throw new RecordAlreadyExistsError("run", runId);
          }
          const nextJob = decodeJobRecord({
            ...job,
            status: "active",
            timestamps: {
              ...job.timestamps,
              completedAt: null,
              failedAt: null,
            },
          });
          const run = buildRunRecord(runId, {
            ...input,
            links: { ...(input.links ?? {}), jobId },
          });
          await transaction.write({ nextJob, previousJob: job, run });
          return {
            claim: { job: cloneValue(nextJob), run: cloneRun(run) },
            status: "claimed",
          };
        });
      }
    );
    if (outcome.status === "settled") {
      throw new JobAlreadySettledError(jobId);
    }
    if (outcome.status === "conflict") {
      throw new Error("Job Run claim conflict escaped repository retry");
    }
    return outcome.claim;
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const record = await this.readRun(id);
    return record ? hydrateRunRecord(record) : null;
  }

  async updateRun(
    id: string,
    patch: UpdateRunInput
  ): Promise<RunRecord | null> {
    return this.withMutationLock(`run:${id}`, async () => {
      const stored = await this.readRun(id);
      const existing = stored ? hydrateRunRecord(stored) : null;
      if (!existing) {
        return null;
      }
      if (
        isTerminalRunStatus(existing.status) &&
        patch.status !== undefined &&
        patch.status !== existing.status
      ) {
        return cloneRun(existing);
      }

      const updated = normalizeRunRecord(applyRunPatch(existing, patch));
      await this.writeRun(updated);
      return updated;
    });
  }

  listRuns(query: RunQuery): Promise<RunPage> {
    return this.queryRuns(query);
  }

  async deleteRun(id: string): Promise<void> {
    const [suspensions, frames] = await Promise.all([
      this.listSuspensions({ limit: 1, runId: id }),
      this.readCanonicalFrames(id),
    ]);
    if (suspensions.items.length > 0 || frames.length > 0) {
      throw new RecordInUseError("run", id);
    }
    await this.removeRun(id);
  }

  async findRecoverableRuns(queueId: string): Promise<RecoverableRun[]> {
    const runs = await collectPages((page) =>
      this.queryRuns({
        queueId,
        status: ["queued", "running", "suspended"],
        ...page,
      })
    );
    return runs.map(rowToRecoverable);
  }

  async createSuspension(
    input: CreateSuspensionInput
  ): Promise<SuspensionRecord> {
    const id = input.id ?? generateId("su");
    return this.withMutationLock(`suspension:${id}`, async () => {
      if (await this.readSuspension(id)) {
        throw new RecordAlreadyExistsError("suspension", id);
      }
      if (!(await this.readRun(input.runId))) {
        throw new RunNotFoundError(input.runId);
      }

      const record = decodeSuspensionRecord({
        id,
        kind: input.kind,
        name: input.name,
        occurrence: input.occurrence ?? 0,
        reason: input.reason,
        request: input.request,
        resolution: null,
        revision: 0,
        runId: input.runId,
        status: "pending",
        stepPath: input.stepPath,
        timestamps: {
          cancelledAt: null,
          createdAt: Date.now(),
          resolvedAt: null,
        },
      });
      await this.writeSuspension(record);
      return cloneValue(record);
    });
  }

  async parkSuspension(
    input: CreateSuspensionInput,
    runPatch: Omit<UpdateRunInput, "status"> = {}
  ): Promise<SuspensionParking> {
    const occurrence = input.occurrence ?? 0;
    const address = JSON.stringify([
      input.runId,
      input.stepPath,
      input.name,
      occurrence,
    ]);
    return this.withSuspensionParkingTransaction(
      input.runId,
      address,
      async (transaction) => {
        const storedRun = await transaction.readRun();
        if (!storedRun) {
          throw new RunNotFoundError(input.runId);
        }
        const run = hydrateRunRecord(storedRun);
        const existing = (await transaction.readSuspensions()).find(
          (record) =>
            record.runId === input.runId &&
            record.name === input.name &&
            record.occurrence === occurrence &&
            sameStringArray(record.stepPath, input.stepPath)
        );
        if (existing) {
          if (
            existing.kind !== input.kind ||
            existing.reason !== input.reason ||
            !jsonValuesEqual(existing.request, input.request)
          ) {
            throw new SuspensionOccurrenceMismatchError(existing.id);
          }
          return { created: false, suspension: cloneValue(existing) };
        }

        const suspension = decodeSuspensionRecord({
          id: input.id ?? generateId("su"),
          kind: input.kind,
          name: input.name,
          occurrence,
          reason: input.reason,
          request: input.request,
          resolution: null,
          revision: 0,
          runId: input.runId,
          status: "pending",
          stepPath: input.stepPath,
          timestamps: {
            cancelledAt: null,
            createdAt: Date.now(),
            resolvedAt: null,
          },
        });
        const nextRun = normalizeRunRecord(
          applyRunPatch(run, { ...runPatch, status: "suspended" })
        );
        await transaction.write({ run: nextRun, suspension });
        return { created: true, suspension: cloneValue(suspension) };
      }
    );
  }

  getSuspension(id: string): Promise<SuspensionRecord | null> {
    return this.readSuspension(id);
  }

  async listSuspensions(
    query: SuspensionQuery = {}
  ): Promise<Page<SuspensionRecord>> {
    return this.querySuspensions(query);
  }

  async settleSuspension(
    id: string,
    input: SettleSuspensionInput
  ): Promise<SuspensionSettlement> {
    return this.withSuspensionSettlementTransaction(id, async (transaction) => {
      const suspension = await transaction.readSuspension();
      if (!suspension) {
        throw new SuspensionNotFoundError(id);
      }
      if (suspension.status !== "pending") {
        throw new SuspensionAlreadySettledError(id);
      }
      if (suspension.revision !== input.expectedRevision) {
        throw new StaleSuspensionRevisionError(
          id,
          input.expectedRevision,
          suspension.revision
        );
      }

      const storedRun = await transaction.readRun(suspension.runId);
      if (!storedRun) {
        throw new RunNotFoundError(suspension.runId);
      }
      const run = hydrateRunRecord(storedRun);
      if (
        run.status !== "suspended" &&
        !(input.outcome.status === "cancelled" && run.status === "cancelled")
      ) {
        throw new RunNotSuspendedError(run.id);
      }
      const settledAt = Date.now();
      const nextSuspension = decodeSuspensionRecord({
        ...suspension,
        resolution:
          input.outcome.status === "resolved" ? input.outcome.resolution : null,
        revision: suspension.revision + 1,
        status: input.outcome.status,
        timestamps: {
          ...suspension.timestamps,
          cancelledAt: input.outcome.status === "cancelled" ? settledAt : null,
          resolvedAt: input.outcome.status === "resolved" ? settledAt : null,
        },
      });
      const nextRun = normalizeRunRecord(
        applyRunPatch(run, {
          ...input.runPatch,
          status: input.outcome.status === "resolved" ? "queued" : "cancelled",
        })
      );

      await transaction.write({
        nextRun,
        nextSuspension,
        previousRun: run,
        previousSuspension: suspension,
      });
      return {
        run: cloneRun(nextRun),
        suspension: cloneValue(nextSuspension),
      };
    });
  }

  async cancelRunSuspensions(
    runId: string,
    runPatch: Omit<UpdateRunInput, "status"> = {}
  ): Promise<SuspensionCancellation> {
    return this.cancelRunWithSuspensions(runId, runPatch, false);
  }

  async cancelRun(
    runId: string,
    runPatch: Omit<UpdateRunInput, "status"> = {}
  ): Promise<SuspensionCancellation> {
    return this.cancelRunWithSuspensions(runId, runPatch, true);
  }

  private cancelRunWithSuspensions(
    runId: string,
    runPatch: Omit<UpdateRunInput, "status">,
    rejectSettled: boolean
  ): Promise<SuspensionCancellation> {
    return this.withSuspensionCancellationTransaction(
      runId,
      async (transaction) => {
        const storedRun = await transaction.readRun();
        if (!storedRun) {
          throw new RunNotFoundError(runId);
        }
        const run = hydrateRunRecord(storedRun);
        if (isTerminalRunStatus(run.status)) {
          if (rejectSettled) {
            throw new RunAlreadySettledError(runId);
          }
          if (run.status !== "cancelled") {
            return { run: cloneRun(run), suspensions: [] };
          }
        }
        const pending = (await transaction.readSuspensions())
          .filter(
            (record) => record.runId === runId && record.status === "pending"
          )
          .sort((left, right) => left.id.localeCompare(right.id));
        const settledAt = Date.now();
        const cancelled = pending.map((record) =>
          cancelSuspensionRecord(record, settledAt)
        );
        const nextRun = normalizeRunRecord(
          applyRunPatch(run, { ...runPatch, status: "cancelled" })
        );
        await transaction.write({
          nextRun,
          nextSuspensions: cancelled,
          previousRun: run,
          previousSuspensions: pending,
        });
        return {
          run: cloneRun(nextRun),
          suspensions: cancelled.map((record) => cloneValue(record)),
        };
      }
    );
  }

  async deleteSuspension(id: string): Promise<void> {
    const suspension = await this.readSuspension(id);
    if (suspension) {
      const referenced = (
        await this.readCanonicalFrames(suspension.runId)
      ).some(
        (frame) =>
          frame.payload.kind === "suspension" &&
          frame.payload.value.id === suspension.id
      );
      if (referenced) {
        throw new RecordInUseError("suspension", id);
      }
    }
    await this.removeSuspension(id);
  }

  async appendRunFrame(input: AppendRunFrameInput): Promise<RunFrame> {
    return this.withMutationLock(`frame:${input.runId}`, async () => {
      if (!(await this.readRun(input.runId))) {
        throw new RunNotFoundError(input.runId);
      }
      const frames = await this.readCanonicalFrames(input.runId);
      if (isTerminalFramePayload(input.payload)) {
        const existingTerminal = frames.find((frame) =>
          isTerminalFramePayload(frame.payload)
        );
        if (existingTerminal) {
          return cloneValue(existingTerminal);
        }
      }
      const lastFrame = frames.at(-1);
      const frame = decodeRunFrame({
        at: input.at ?? Date.now(),
        cursor: lastFrame === undefined ? 0 : lastFrame.cursor + 1,
        payload: input.payload,
        runId: input.runId,
      });
      decodeRunFrameSequence(input.runId, [...frames, frame]);
      await this.writeFrame(frame);
      return cloneValue(frame);
    });
  }

  async claimRunEffect(input: ClaimRunEffectInput): Promise<RunFrame | null> {
    const payload = runEffectClaimPayload(input);
    return this.withMutationLock(`frame:${input.runId}`, async () => {
      if (!(await this.readRun(input.runId))) {
        throw new RunNotFoundError(input.runId);
      }
      const frames = await this.readCanonicalFrames(input.runId);
      if (frames.some((frame) => isRunEffectClaim(frame, input.key))) {
        return null;
      }
      const lastFrame = frames.at(-1);
      const frame = decodeRunFrame({
        at: input.at ?? Date.now(),
        cursor: lastFrame === undefined ? 0 : lastFrame.cursor + 1,
        payload,
        runId: input.runId,
      });
      decodeRunFrameSequence(input.runId, [...frames, frame]);
      await this.writeFrame(frame);
      return cloneValue(frame);
    });
  }

  async listRunFrames(runId: string, after = -1): Promise<RunFrame[]> {
    if (!(await this.readRun(runId))) {
      throw new RunNotFoundError(runId);
    }
    const frames = await this.readCanonicalFrames(runId);
    return frames
      .filter((frame) => frame.cursor > after)
      .map((frame) => cloneValue(frame));
  }

  async listFrames(query: RunFramePageQuery = {}): Promise<Page<RunFrame>> {
    const runIds =
      query.runId === undefined
        ? (await this.readRuns()).map((run) => run.id)
        : [query.runId];
    const frames = (
      await Promise.all(runIds.map((runId) => this.listRunFrames(runId)))
    )
      .flat()
      .filter(
        (frame) => query.after === undefined || frame.cursor > query.after
      )
      .sort((left, right) => {
        const direction = query.order === "newest" ? -1 : 1;
        return (
          direction *
          (left.at - right.at ||
            left.runId.localeCompare(right.runId) ||
            left.cursor - right.cursor)
        );
      });
    return pageValues(frames, query, 100);
  }

  async countFrames(
    query: Pick<RunFramePageQuery, "runId" | "after"> = {}
  ): Promise<number> {
    const runIds =
      query.runId === undefined
        ? (await this.readRuns()).map((run) => run.id)
        : [query.runId];
    const frames = await Promise.all(
      runIds.map((runId) => this.listRunFrames(runId, query.after))
    );
    return frames.reduce((total, values) => total + values.length, 0);
  }

  async listFrameRuns(
    query: { limit?: number; offset?: number; order?: "newest" | "oldest" } = {}
  ): Promise<Page<FrameRun>> {
    const runs = await this.readRuns();
    const values = (
      await Promise.all(
        runs.map(async (run): Promise<FrameRun | null> => {
          const frames = await this.listRunFrames(run.id);
          const last = frames.at(-1);
          return last === undefined ? null : { lastAt: last.at, runId: run.id };
        })
      )
    )
      .filter((value): value is FrameRun => value !== null)
      .sort((left, right) => {
        const direction = query.order === "oldest" ? 1 : -1;
        return (
          direction *
          (left.lastAt - right.lastAt || left.runId.localeCompare(right.runId))
        );
      });
    return pageValues(values, query, 3);
  }

  async countFrameRuns(): Promise<number> {
    const runs = await this.readRuns();
    const counts = await Promise.all(
      runs.map((run) => this.countFrames({ runId: run.id }))
    );
    return counts.filter((value) => value > 0).length;
  }

  deleteRunFrames(runId: string): Promise<void> {
    return this.removeFrames(runId);
  }

  async ensureQueue(input: EnsureQueueInput): Promise<QueueRecord> {
    const record: QueueRecord = {
      createdAt: Date.now(),
      extensions: createExtensions(input.extensions),
      id: input.id,
      lastError: null,
      name: input.name,
      status: "active",
    };
    return this.ensureQueueRecord(record);
  }

  listQueues(): Promise<QueueRecord[]> {
    return this.readQueues();
  }

  async updateQueue(
    id: string,
    patch: UpdateQueueInput
  ): Promise<QueueRecord | null> {
    const existing = await this.readQueue(id);
    if (!existing) {
      return null;
    }

    const updated: QueueRecord = {
      ...existing,
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.lastError === undefined ? {} : { lastError: patch.lastError }),
      ...(patch.extensions === undefined
        ? {}
        : {
            extensions: mergeExtensions(existing.extensions, patch.extensions),
          }),
    };
    await this.writeQueue(updated);
    return updated;
  }

  protected matchesRunQuery(record: RunRecord, query: RunQuery): boolean {
    if (query.queueId !== undefined && record.queueId !== query.queueId) {
      return false;
    }
    const search = query.search?.trim().toLocaleLowerCase();
    if (
      search &&
      ![
        record.id,
        record.queueId,
        record.step,
        record.definition?.name,
        record.links?.sessionId,
        record.links?.invocationId,
        record.links?.subjectId,
      ].some((value) => value?.toLocaleLowerCase().includes(search) === true)
    ) {
      return false;
    }
    if (query.status !== undefined) {
      const statuses = Array.isArray(query.status)
        ? query.status
        : [query.status];
      if (!statuses.includes(record.status)) {
        return false;
      }
    }
    if (query.tags !== undefined && !this.hasTags(record.tags, query.tags)) {
      return false;
    }
    if (
      query.definition !== undefined &&
      record.definition?.name !== query.definition
    ) {
      return false;
    }
    return this.matchesLinks(record.links ?? {}, query.links);
  }

  /** Apply the legacy metadata bridge only for adapters that expose raw rows. */
  protected hydrateStoredRun(record: RunRecord): RunRecord {
    return hydrateRunRecord(record);
  }

  protected matchesJobQuery(record: JobRecord, query: JobQuery): boolean {
    if (query.status !== undefined) {
      const statuses = Array.isArray(query.status)
        ? query.status
        : [query.status];
      if (!statuses.includes(record.status)) {
        return false;
      }
    }
    if (
      query.definition !== undefined &&
      record.definition.name !== query.definition
    ) {
      return false;
    }
    return this.matchesLinks(record.links, query.links);
  }

  protected matchesSuspensionQuery(
    record: SuspensionRecord,
    query: SuspensionQuery
  ): boolean {
    if (query.runId !== undefined && record.runId !== query.runId) {
      return false;
    }
    if (query.kind !== undefined && record.kind !== query.kind) {
      return false;
    }
    if (query.name !== undefined && record.name !== query.name) {
      return false;
    }
    if (
      query.occurrence !== undefined &&
      record.occurrence !== query.occurrence
    ) {
      return false;
    }
    if (
      query.stepPath !== undefined &&
      !sameStringArray(record.stepPath, query.stepPath)
    ) {
      return false;
    }
    if (query.status !== undefined) {
      const statuses = Array.isArray(query.status)
        ? query.status
        : [query.status];
      if (!statuses.includes(record.status)) {
        return false;
      }
    }
    return true;
  }

  protected hasTags(
    tags: Record<string, string>,
    query: Record<string, string>
  ): boolean {
    return Object.entries(query).every(([key, value]) => tags[key] === value);
  }

  protected matchesLinks<T extends object>(
    links: T,
    query: Partial<T> | undefined
  ): boolean {
    if (query === undefined) {
      return true;
    }
    return Object.entries(query).every(
      ([key, value]) => links[key as keyof T] === value
    );
  }

  protected async writeJobRunClaim(input: {
    previousJob: JobRecord;
    nextJob: JobRecord;
    run: RunRecord;
  }): Promise<void> {
    await this.writeJob(input.nextJob);
    try {
      await this.writeRun(input.run);
    } catch (error) {
      await this.writeJob(input.previousJob);
      throw error;
    }
  }

  /**
   * Wrap the complete read/validate/write managed-attempt operation. The
   * reference adapter uses the in-process Job mutex. Durable adapters must
   * override this hook and provide transaction-bound reads plus the atomic
   * Job/Run write through `operation`.
   */
  protected withJobRunClaimTransaction(
    jobId: string,
    operation: (
      transaction: JobRunClaimTransaction
    ) => Promise<JobRunClaimOutcome>
  ): Promise<JobRunClaimOutcome> {
    return this.withMutationLock(`job:${jobId}`, () =>
      operation({
        readJob: () => this.readJob(jobId),
        readRun: (runId) => this.readRun(runId),
        readRuns: () => this.readRuns(),
        write: (input) => this.writeJobRunClaim(input),
        writeJob: (record) => this.writeJob(record),
      })
    );
  }

  /**
   * Own cancellation of one Job plus its active Run and pending Suspensions.
   * Durable adapters override this hook with one database transaction. The
   * reference adapter uses the same Job-first lock order as managed claims.
   */
  protected withJobCancellationTransaction(
    jobId: string,
    operation: (
      transaction: JobCancellationTransaction
    ) => Promise<JobCancellation>
  ): Promise<JobCancellation> {
    return this.withMutationLock(`job:${jobId}`, async () => {
      const active = (await this.readRuns())
        .map(hydrateRunRecord)
        .find(
          (run) =>
            run.links?.jobId === jobId && isNonTerminalRunStatus(run.status)
        );
      const invoke = (): Promise<JobCancellation> =>
        operation({
          readJob: () => this.readJob(jobId),
          readRuns: () => this.readRuns(),
          readSuspensions: () => this.readSuspensions(),
          write: (input) => this.writeJobCancellation(input),
        });
      if (!active) {
        return invoke();
      }
      return this.withMutationLock(`run:${active.id}`, async () => {
        const suspensionIds = (await this.readSuspensions())
          .filter((record) => record.runId === active.id)
          .map((record) => record.id)
          .sort();
        const withLocks = (index: number): Promise<JobCancellation> => {
          const suspensionId = suspensionIds[index];
          return suspensionId === undefined
            ? invoke()
            : this.withMutationLock(`suspension:${suspensionId}`, () =>
                withLocks(index + 1)
              );
        };
        return withLocks(0);
      });
    });
  }

  protected async writeJobCancellation(input: {
    previousJob: JobRecord;
    nextJob: JobRecord;
    previousRun: RunRecord | null;
    nextRun: RunRecord | null;
    previousSuspensions: readonly SuspensionRecord[];
    nextSuspensions: readonly SuspensionRecord[];
  }): Promise<void> {
    await this.writeJob(input.nextJob);
    try {
      if (input.nextRun) {
        await this.writeRun(input.nextRun);
      }
      for (const suspension of input.nextSuspensions) {
        await this.writeSuspension(suspension);
      }
    } catch (error) {
      await this.writeJob(input.previousJob);
      if (input.previousRun) {
        await this.writeRun(input.previousRun);
      }
      for (const suspension of input.previousSuspensions) {
        await this.writeSuspension(suspension);
      }
      throw error;
    }
  }

  /**
   * Own the complete occurrence-address read/validate/write boundary. Durable
   * adapters must override this hook with a database transaction and enforce a
   * unique key on `(runId, stepPath, name, occurrence)`.
   */
  protected withSuspensionParkingTransaction(
    runId: string,
    address: string,
    operation: (
      transaction: SuspensionParkingTransaction
    ) => Promise<SuspensionParking>
  ): Promise<SuspensionParking> {
    return this.withMutationLock(`run:${runId}`, () =>
      this.withMutationLock(`suspension-address:${address}`, () =>
        operation({
          readRun: () => this.readRun(runId),
          readSuspensions: () => this.readSuspensions(),
          write: (input) => this.writeSuspensionParking(input),
        })
      )
    );
  }

  /**
   * Own the full conditional settlement. The preliminary read exists only to
   * choose the reference adapter's Run lock; durable adapters override this
   * hook and perform every read and write inside one transaction.
   */
  protected async withSuspensionSettlementTransaction(
    id: string,
    operation: (
      transaction: SuspensionSettlementTransaction
    ) => Promise<SuspensionSettlement>
  ): Promise<SuspensionSettlement> {
    const initial = await this.readSuspension(id);
    if (!initial) {
      return this.withMutationLock(`suspension:${id}`, () =>
        operation({
          readRun: (runId) => this.readRun(runId),
          readSuspension: () => this.readSuspension(id),
          write: (input) => this.writeSuspensionSettlement(input),
        })
      );
    }
    return this.withMutationLock(`run:${initial.runId}`, () =>
      this.withMutationLock(`suspension:${id}`, () =>
        operation({
          readRun: (runId) => this.readRun(runId),
          readSuspension: () => this.readSuspension(id),
          write: (input) => this.writeSuspensionSettlement(input),
        })
      )
    );
  }

  /** Own atomic Run cancellation plus settlement of all pending Suspensions. */
  protected withSuspensionCancellationTransaction(
    runId: string,
    operation: (
      transaction: SuspensionCancellationTransaction
    ) => Promise<SuspensionCancellation>
  ): Promise<SuspensionCancellation> {
    return this.withMutationLock(`run:${runId}`, async () => {
      const ids = (await this.readSuspensions())
        .filter((record) => record.runId === runId)
        .map((record) => record.id)
        .sort();
      const withLocks = (index: number): Promise<SuspensionCancellation> => {
        const id = ids[index];
        if (id === undefined) {
          return operation({
            readRun: () => this.readRun(runId),
            readSuspensions: () => this.readSuspensions(),
            write: (input) => this.writeSuspensionCancellation(input),
          });
        }
        return this.withMutationLock(`suspension:${id}`, () =>
          withLocks(index + 1)
        );
      };
      return withLocks(0);
    });
  }

  protected async writeSuspensionSettlement(input: {
    previousSuspension: SuspensionRecord;
    nextSuspension: SuspensionRecord;
    previousRun: RunRecord;
    nextRun: RunRecord;
  }): Promise<void> {
    await this.writeRun(input.nextRun);
    try {
      await this.writeSuspension(input.nextSuspension);
    } catch (error) {
      await this.writeRun(input.previousRun);
      throw error;
    }
  }

  protected async writeSuspensionParking(input: {
    suspension: SuspensionRecord;
    run: RunRecord;
  }): Promise<void> {
    const previousRun = await this.readRun(input.run.id);
    await this.writeRun(input.run);
    try {
      await this.writeSuspension(input.suspension);
    } catch (error) {
      if (previousRun) {
        await this.writeRun(previousRun);
      }
      throw error;
    }
  }

  protected async writeSuspensionCancellation(input: {
    previousRun: RunRecord;
    nextRun: RunRecord;
    previousSuspensions: readonly SuspensionRecord[];
    nextSuspensions: readonly SuspensionRecord[];
  }): Promise<void> {
    await this.writeRun(input.nextRun);
    const written: SuspensionRecord[] = [];
    try {
      for (const suspension of input.nextSuspensions) {
        await this.writeSuspension(suspension);
        written.push(suspension);
      }
    } catch (error) {
      await this.writeRun(input.previousRun);
      for (const record of written) {
        const previous = input.previousSuspensions.find(
          (candidate) => candidate.id === record.id
        );
        if (previous) {
          await this.writeSuspension(previous);
        }
      }
      throw error;
    }
  }

  private async readCanonicalFrames(runId: string): Promise<RunFrame[]> {
    return decodeRunFrameSequence(runId, await this.readFrames(runId));
  }

  /**
   * First-writer-wins Queue insertion seam. Durable adapters override this
   * method with one atomic insert-or-return-existing database operation.
   */
  protected ensureQueueRecord(record: QueueRecord): Promise<QueueRecord> {
    return this.withMutationLock(`queue:${record.id}`, async () => {
      const existing = await this.readQueue(record.id);
      if (existing) {
        return cloneQueue(existing);
      }
      await this.writeQueue(record);
      return cloneQueue(record);
    });
  }

  private async withMutationLock<T>(
    key: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.#mutationTails.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#mutationTails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#mutationTails.get(key) === tail) {
        this.#mutationTails.delete(key);
      }
    }
  }

  protected abstract readJob(id: string): Promise<JobRecord | null>;
  protected abstract writeJob(record: JobRecord): Promise<void>;
  protected abstract readJobs(): Promise<JobRecord[]>;
  protected abstract queryJobs(query: JobQuery): Promise<Page<JobRecord>>;
  protected abstract removeJob(id: string): Promise<void>;
  protected abstract readRun(id: string): Promise<RunRecord | null>;
  protected abstract writeRun(record: RunRecord): Promise<void>;
  protected abstract readRuns(): Promise<RunRecord[]>;
  protected abstract queryRuns(query: RunQuery): Promise<RunPage>;
  protected abstract removeRun(id: string): Promise<void>;
  protected abstract readSuspension(
    id: string
  ): Promise<SuspensionRecord | null>;
  protected abstract writeSuspension(record: SuspensionRecord): Promise<void>;
  protected abstract readSuspensions(): Promise<SuspensionRecord[]>;
  protected abstract querySuspensions(
    query: SuspensionQuery
  ): Promise<Page<SuspensionRecord>>;
  protected abstract removeSuspension(id: string): Promise<void>;
  protected abstract readQueue(id: string): Promise<QueueRecord | null>;
  protected abstract writeQueue(record: QueueRecord): Promise<void>;
  protected abstract readQueues(): Promise<QueueRecord[]>;
  protected abstract writeFrame(frame: RunFrame): Promise<void>;
  protected abstract readFrames(runId: string): Promise<RunFrame[]>;
  protected abstract removeFrames(runId: string): Promise<void>;
}

/** Execution policy composed over durable records and an ordered Run journal. */
export class ExecutionCoordinator extends AbstractOrchestratorStore {
  constructor(
    private readonly repository: ExecutionRepository,
    private readonly journal: RunJournal
  ) {
    super();
  }

  override appendRunFrame(input: AppendRunFrameInput): Promise<RunFrame> {
    return this.journal.appendRunFrame(input);
  }

  override claimRunEffect(
    input: ClaimRunEffectInput
  ): Promise<RunFrame | null> {
    return this.journal.claimRunEffect(input);
  }

  override listRunFrames(runId: string, after?: number): Promise<RunFrame[]> {
    return this.journal.listRunFrames(runId, after);
  }

  override listFrames(query?: RunFramePageQuery): Promise<Page<RunFrame>> {
    return this.journal.listFrames(query);
  }

  override countFrames(
    query?: Pick<RunFramePageQuery, "runId" | "after">
  ): Promise<number> {
    return this.journal.countFrames(query);
  }

  override listFrameRuns(query?: {
    limit?: number;
    offset?: number;
    order?: "newest" | "oldest";
  }): Promise<Page<FrameRun>> {
    return this.journal.listFrameRuns(query);
  }

  override countFrameRuns(): Promise<number> {
    return this.journal.countFrameRuns();
  }

  override deleteRunFrames(runId: string): Promise<void> {
    return this.journal.deleteRunFrames(runId);
  }

  protected readJob(id: string): Promise<JobRecord | null> {
    return this.repository.getJob(id);
  }

  protected writeJob(record: JobRecord): Promise<void> {
    return this.repository.putJob(record);
  }

  protected readJobs(): Promise<JobRecord[]> {
    return collectPages((page) => this.repository.listJobRecords(page));
  }

  protected queryJobs(query: JobQuery): Promise<Page<JobRecord>> {
    return this.repository.listJobRecords(query);
  }

  protected removeJob(id: string): Promise<void> {
    return this.repository.deleteJobRecord(id);
  }

  protected readRun(id: string): Promise<RunRecord | null> {
    return this.repository.getRun(id);
  }

  protected writeRun(record: RunRecord): Promise<void> {
    return this.repository.putRun(record);
  }

  protected readRuns(): Promise<RunRecord[]> {
    return collectPages((page) => this.repository.listRunRecords(page));
  }

  protected queryRuns(query: RunQuery): Promise<RunPage> {
    return this.repository.listRunRecords(query);
  }

  protected removeRun(id: string): Promise<void> {
    return this.repository.deleteRunRecord(id);
  }

  protected readSuspension(id: string): Promise<SuspensionRecord | null> {
    return this.repository.getSuspension(id);
  }

  protected writeSuspension(record: SuspensionRecord): Promise<void> {
    return this.repository.putSuspension(record);
  }

  protected readSuspensions(): Promise<SuspensionRecord[]> {
    return collectPages((page) => this.repository.listSuspensionRecords(page));
  }

  protected querySuspensions(
    query: SuspensionQuery
  ): Promise<Page<SuspensionRecord>> {
    return this.repository.listSuspensionRecords(query);
  }

  protected removeSuspension(id: string): Promise<void> {
    return this.repository.deleteSuspensionRecord(id);
  }

  protected readQueue(id: string): Promise<QueueRecord | null> {
    return this.repository.getQueue(id);
  }

  protected writeQueue(record: QueueRecord): Promise<void> {
    return this.repository.putQueue(record);
  }

  protected readQueues(): Promise<QueueRecord[]> {
    return this.repository.listQueueRecords();
  }

  protected override ensureQueueRecord(
    record: QueueRecord
  ): Promise<QueueRecord> {
    return this.repository.ensureQueueRecord(record);
  }

  protected writeFrame(frame: RunFrame): Promise<void> {
    return this.journal
      .appendRunFrame({
        at: frame.at,
        payload: frame.payload,
        runId: frame.runId,
      })
      .then(() => undefined);
  }

  protected readFrames(runId: string): Promise<RunFrame[]> {
    return this.journal.listRunFrames(runId);
  }

  protected removeFrames(runId: string): Promise<void> {
    return this.journal.deleteRunFrames(runId);
  }

  protected override withJobRunClaimTransaction(
    jobId: string,
    operation: (
      transaction: JobRunClaimTransaction
    ) => Promise<JobRunClaimOutcome>
  ): Promise<JobRunClaimOutcome> {
    return retryAggregateCommit(
      "job.claim-run",
      async () => {
        let expectedJob: JobRecord | null = null;
        let expectedRuns: RunRecord[] = [];
        let commit: JobRunClaimCommit | undefined;
        const result = await operation({
          readJob: async () => {
            expectedJob = await this.repository.getJob(jobId);
            return expectedJob;
          },
          readRun: (runId) => this.repository.getRun(runId),
          readRuns: async () => {
            expectedRuns = await this.readRuns();
            return expectedRuns;
          },
          write: ({ previousJob, nextJob, run }) => {
            commit = {
              expectedJob: previousJob,
              expectedRuns: linkedRuns(expectedRuns, jobId),
              nextJob,
              run,
              status: "claimed",
            };
            return Promise.resolve();
          },
          writeJob: (nextJob) => {
            if (!expectedJob) {
              throw new Error("Job claim must read before write");
            }
            commit = {
              expectedJob,
              expectedRuns: linkedRuns(expectedRuns, jobId),
              nextJob,
              status: "settled",
            };
            return Promise.resolve();
          },
        });
        return { result, ...(commit === undefined ? {} : { commit }) };
      },
      (commit) => this.repository.commitJobRunClaim(commit),
      (_result, outcome) => outcome
    );
  }

  protected override withJobCancellationTransaction(
    jobId: string,
    operation: (
      transaction: JobCancellationTransaction
    ) => Promise<JobCancellation>
  ): Promise<JobCancellation> {
    return retryAggregateCommit(
      "job.cancel",
      async () => {
        let commit: JobCancellationCommit | undefined;
        let expectedRuns: RunRecord[] = [];
        const result = await operation({
          readJob: () => this.repository.getJob(jobId),
          readRuns: async () => {
            expectedRuns = await this.readRuns();
            return expectedRuns;
          },
          readSuspensions: () => this.readSuspensions(),
          write: (input) => {
            commit = {
              ...input,
              expectedRuns: linkedRuns(expectedRuns, jobId),
            };
            return Promise.resolve();
          },
        });
        return { result, ...(commit === undefined ? {} : { commit }) };
      },
      (commit) => this.repository.commitJobCancellation(commit),
      (result) => result
    );
  }

  protected override withSuspensionParkingTransaction(
    runId: string,
    _address: string,
    operation: (
      transaction: SuspensionParkingTransaction
    ) => Promise<SuspensionParking>
  ): Promise<SuspensionParking> {
    return retryAggregateCommit(
      "suspension.park",
      async () => {
        let previousRun: RunRecord | null = null;
        let expectedSuspensions: SuspensionRecord[] = [];
        let commit: SuspensionParkingCommit | undefined;
        const result = await operation({
          readRun: async () => {
            previousRun = await this.repository.getRun(runId);
            return previousRun;
          },
          readSuspensions: async () => {
            expectedSuspensions = await this.readSuspensions();
            return expectedSuspensions;
          },
          write: ({ suspension, run }) => {
            if (!previousRun) {
              throw new Error("Suspension parking must read Run before write");
            }
            commit = {
              expectedSuspensions: runSuspensions(expectedSuspensions, runId),
              nextRun: run,
              previousRun,
              suspension,
            };
            return Promise.resolve();
          },
        });
        return { result, ...(commit === undefined ? {} : { commit }) };
      },
      (commit) => this.repository.commitSuspensionParking(commit),
      (result) => result
    );
  }

  protected override withSuspensionSettlementTransaction(
    id: string,
    operation: (
      transaction: SuspensionSettlementTransaction
    ) => Promise<SuspensionSettlement>
  ): Promise<SuspensionSettlement> {
    return retryAggregateCommit(
      "suspension.settle",
      async () => {
        let commit: SuspensionSettlementCommit | undefined;
        const result = await operation({
          readRun: (runId) => this.repository.getRun(runId),
          readSuspension: () => this.repository.getSuspension(id),
          write: (input) => {
            commit = input;
            return Promise.resolve();
          },
        });
        return { result, ...(commit === undefined ? {} : { commit }) };
      },
      (commit) => this.repository.commitSuspensionSettlement(commit),
      (result) => result
    );
  }

  protected override withSuspensionCancellationTransaction(
    runId: string,
    operation: (
      transaction: SuspensionCancellationTransaction
    ) => Promise<SuspensionCancellation>
  ): Promise<SuspensionCancellation> {
    return retryAggregateCommit(
      "run.cancel-suspensions",
      async () => {
        let commit: SuspensionCancellationCommit | undefined;
        const result = await operation({
          readRun: () => this.repository.getRun(runId),
          readSuspensions: () => this.readSuspensions(),
          write: (input) => {
            commit = input;
            return Promise.resolve();
          },
        });
        return { result, ...(commit === undefined ? {} : { commit }) };
      },
      (commit) => this.repository.commitSuspensionCancellation(commit),
      (result) => result
    );
  }
}

function cloneRun(run: RunRecord): RunRecord {
  return cloneValue(run);
}

function linkedRuns(runs: readonly RunRecord[], jobId: string): RunRecord[] {
  return runs.filter((run) => run.links?.jobId === jobId).map(cloneRun);
}

function runSuspensions(
  suspensions: readonly SuspensionRecord[],
  runId: string
): SuspensionRecord[] {
  return suspensions
    .filter((suspension) => suspension.runId === runId)
    .map(cloneValue);
}

function cloneQueue(queue: QueueRecord): QueueRecord {
  return cloneValue(queue);
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function applyRunPatch(existing: RunRecord, patch: UpdateRunInput): RunRecord {
  return {
    ...existing,
    ...(patch.status === undefined ? {} : { status: patch.status }),
    ...(patch.output === undefined ? {} : { output: patch.output }),
    ...(patch.error === undefined ? {} : { error: patch.error }),
    ...(patch.snapshot === undefined ? {} : { snapshot: patch.snapshot }),
    ...(patch.tags === undefined
      ? {}
      : { tags: { ...existing.tags, ...patch.tags } }),
    ...(patch.timestamps === undefined
      ? {}
      : { timestamps: { ...existing.timestamps, ...patch.timestamps } }),
    ...(patch.metadata === undefined
      ? {}
      : {
          metadata: withExecutionMetadata(
            patch.metadata,
            existing.definition,
            existing.links
          ),
        }),
    ...(patch.extensions === undefined
      ? {}
      : {
          extensions: mergeExtensions(existing.extensions, patch.extensions),
        }),
  };
}

function withExecutionMetadata(
  metadata: Record<string, unknown>,
  definition: DefinitionReference | undefined,
  links: RunLinks | undefined
): Record<string, unknown> {
  if (definition === undefined && links === undefined) {
    return metadata;
  }
  return {
    ...metadata,
    [EXECUTION_METADATA_KEY]: {
      ...(definition === undefined ? {} : { definition }),
      ...(links === undefined ? {} : { links }),
    },
  };
}

function hydrateRunRecord(record: RunRecord): RunRecord {
  const execution = record.metadata[EXECUTION_METADATA_KEY];
  if (!isUnknownRecord(execution)) {
    return normalizeRunRecord(record);
  }
  return normalizeRunRecord({
    ...record,
    ...(record.definition === undefined
      ? {
          definition: execution.definition as DefinitionReference | undefined,
        }
      : {}),
    ...(record.links === undefined
      ? { links: execution.links as RunLinks | undefined }
      : {}),
  });
}

function buildRunRecord(
  id: string,
  input: Omit<CreateRunInput, "links"> & { links?: RunLinks }
): RunRecord {
  return normalizeRunRecord({
    error: null,
    extensions: createExtensions(input.extensions),
    id,
    input: input.input,
    metadata: withExecutionMetadata(
      input.metadata ?? {},
      input.definition,
      input.links
    ),
    output: null,
    queueId: input.queueId,
    snapshot: input.snapshot ?? emptyWorkflowSnapshot(),
    status: "queued",
    step: input.step,
    tags: input.tags ?? {},
    timestamps: {
      completedAt: null,
      createdAt: Date.now(),
      failedAt: null,
      startedAt: null,
    },
    ...(input.definition === undefined
      ? {}
      : { definition: cloneValue(input.definition) }),
    ...(input.links === undefined ? {} : { links: cloneValue(input.links) }),
  });
}

function normalizeRunRecord(record: RunRecord): RunRecord {
  const normalized: RunRecord = {
    ...record,
    extensions: createExtensions(record.extensions),
    input: normalizeJsonValue(record.input),
    metadata: normalizeJsonValue(record.metadata) as Record<string, unknown>,
    output: normalizeJsonValue(record.output),
    snapshot: normalizeJsonValue({
      ...record.snapshot,
      input: normalizeJsonValue(record.snapshot.input),
    }) as unknown as WorkflowSnapshot,
    ...(record.definition === undefined
      ? {}
      : { definition: cloneValue(record.definition) }),
    ...(record.links === undefined ? {} : { links: cloneValue(record.links) }),
  };
  const schemaCandidate = normalized.id.startsWith("rn-")
    ? normalized
    : { ...normalized, id: "rn-legacy" };
  decodeRunRecord(schemaCandidate);
  return normalized;
}

function normalizeJsonValue(
  value: unknown,
  ancestors = new WeakSet()
): JsonValue {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Run data must be JSON-safe");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Error("Run data must be JSON-safe");
  }
  if (ancestors.has(value)) {
    throw new Error("Run data must be acyclic");
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new Error("Run data must be JSON-safe");
      }
      return Array.from({ length: value.length }, (_, index) =>
        Object.hasOwn(value, index)
          ? normalizeJsonValue(value[index], ancestors)
          : null
      );
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Run data must contain only plain objects");
    }
    const normalized: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        normalized[key] = normalizeJsonValue(entry, ancestors);
      }
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminalFramePayload(payload: RunFramePayload): boolean {
  if (payload.kind !== "lifecycle") {
    return false;
  }
  const value = payload.value;
  if (!isUnknownRecord(value)) {
    return false;
  }
  const event = value.event;
  return event === "complete" || event === "failed" || event === "cancelled";
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!(Array.isArray(left) && Array.isArray(right))) {
      return false;
    }
    const leftArray = left as readonly JsonValue[];
    const rightArray = right as readonly JsonValue[];
    return (
      leftArray.length === rightArray.length &&
      leftArray.every((value, index) => {
        const rightValue = rightArray[index];
        return rightValue !== undefined && jsonValuesEqual(value, rightValue);
      })
    );
  }
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }
  const leftRecord = left as Readonly<Record<string, JsonValue>>;
  const rightRecord = right as Readonly<Record<string, JsonValue>>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    sameStringArray(leftKeys, rightKeys) &&
    leftKeys.every((key) => {
      const leftValue = leftRecord[key];
      const rightValue = rightRecord[key];
      return (
        leftValue !== undefined &&
        rightValue !== undefined &&
        jsonValuesEqual(leftValue, rightValue)
      );
    })
  );
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "complete" || status === "failed" || status === "cancelled";
}

function isNonTerminalRunStatus(status: RunStatus): boolean {
  return status === "queued" || status === "running" || status === "suspended";
}

function isTerminalJobStatus(status: JobStatus): boolean {
  return status === "complete" || status === "failed" || status === "cancelled";
}

function cancelSuspensionRecord(
  record: SuspensionRecord,
  cancelledAt: number
): SuspensionRecord {
  return decodeSuspensionRecord({
    ...record,
    resolution: null,
    revision: record.revision + 1,
    status: "cancelled",
    timestamps: {
      ...record.timestamps,
      cancelledAt,
      resolvedAt: null,
    },
  });
}

function emptyWorkflowSnapshot(): WorkflowSnapshot {
  return { cursor: null, input: null, name: "", steps: [] };
}
