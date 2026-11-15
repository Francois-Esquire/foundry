import type { Page } from "@foundry/core/pagination";
import { detached } from "./detached";
import {
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
  CreateJobInput,
  CreateJobRunInput,
  CreateRunInput,
  CreateSuspensionInput,
  EnsureQueueInput,
  ExecutionCommands,
  JobCancellation,
  JobQuery,
  JobRunClaim,
  PageQuery,
  RecoverableRun,
  RunQuery,
  SettleSuspensionInput,
  SuspensionCancellation,
  SuspensionParking,
  SuspensionQuery,
  SuspensionSettlement,
  UpdateJobInput,
  UpdateQueueInput,
  UpdateRunInput,
} from "./execution-commands";
import {
  decodeJobRecord,
  decodeRunRecord,
  decodeSuspensionRecord,
  runCheckedAs,
} from "./execution-records";
import { createExtensions, mergeExtensions } from "./extensions";
import type { JsonValue } from "./json-value";
import { jsonValuesEqual } from "./json-value";
import { rowToRecoverable } from "./metadata-codec";
import { defineOwnEntry } from "./own-entry";
import { runEvents, withEvents } from "./run-events";
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
import type {
  DefinitionReference,
  JobRecord,
  JobStatus,
  OrchestratorStoreSnapshot,
  QueueRecord,
  RunFrame,
  RunFramePayload,
  RunLinks,
  RunRecord,
  RunStatus,
  SuspensionRecord,
  SuspensionStatus,
  WorkflowSnapshot,
} from "./schema";
import { ORCHESTRATOR_STORE_SNAPSHOT_VERSION } from "./schema";
import type {
  WorkflowStore,
  WorkflowStoreDurability,
  WorkflowStorePage,
  WorkflowStorePageQuery,
} from "./store/index";
import { MemoryWorkflowStore } from "./store/memory";
import { validateOrchestratorStoreSnapshot } from "./store-snapshot";

/**
 * The execution records' domain API: Jobs, Runs, Suspensions, Queues and
 * the Run journal. `Queue` and `Orchestrator` work through it; a host may
 * supply its own.
 */
export interface OrchestratorStore extends ExecutionCommands, RunJournal {
  /**
   * When a change that resolved is there for good; `"commit"` when absent
   * (see `WorkflowStoreDurability`). The `Orchestrator` and `Queue` refuse
   * a `"host"` store.
   */
  readonly durability?: WorkflowStoreDurability;
  /**
   * Runs `work` over a store bound to one store transaction, so everything
   * it does lands together or not at all, and no other write lands between
   * its reads and its writes. Present only over a `WorkflowStore` that
   * offers `transaction`. `work` uses the store it is given; a call to this
   * store from inside `work` is refused.
   */
  readonly transaction?: <T>(
    work: (store: OrchestratorStore) => Promise<T>
  ) => Promise<T>;
}

export interface ExecutionCoordinatorOptions {
  /** Where the records live; a new `MemoryWorkflowStore` when absent. */
  readonly store?: WorkflowStore;
}

function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

const EXECUTION_METADATA_KEY = "workflows.execution";
/** How many records one store read returns when the coordinator reads them all. */
const STORE_PAGE_LIMIT = 500;
const LIVE_RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
  "suspended",
];

/** Set by `ExecutionCoordinator`'s static block: its claim, as an outcome. */
let claimOn: (
  coordinator: ExecutionCoordinator,
  jobId: string,
  input: CreateJobRunInput
) => Promise<JobRunClaimOutcome>;

/**
 * Every rule of the execution records, over a `WorkflowStore` that keeps
 * them: creation defaults, lifecycle transitions, patch semantics, the
 * atomic aggregates (a managed Job attempt, a cancellation, a parked or
 * settled Suspension), first-writer Queues, unique ids, and the frame
 * sequence of each Run's journal. The store enforces none of these.
 *
 * Each change to a Run also builds change events (`RunEvent`: `run.queued`,
 * `run.started`, `run.updated`, ...; see `runEvents`) and carries them in
 * the same write (`WorkflowStoreWrite.events`), so a host's hook inside the
 * commit records them with the change or not at all. A change that leaves
 * every Run's status and own fields as they were carries none.
 *
 * Each change is one read-modify-write ending in one `commit`. When the
 * store offers `transaction`, each runs inside one, so coordinators sharing
 * a store (two engines on one database) never interleave. Otherwise the
 * changes of this coordinator are serialized and no further. A read made
 * of several store reads runs in a transaction too, so it sees one state.
 *
 * The store's list reads filter only by exact values. Searching, matching
 * tags and links, sorting by creation time and paging happen here, over
 * every record the store's filter returns.
 */
export class ExecutionCoordinator implements OrchestratorStore {
  readonly durability: WorkflowStoreDurability;
  readonly transaction?: <T>(
    work: (store: OrchestratorStore) => Promise<T>
  ) => Promise<T>;
  readonly #store: WorkflowStore;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: ExecutionCoordinatorOptions = {}) {
    const store = options.store ?? new MemoryWorkflowStore();
    this.#store = store;
    this.durability = store.durability ?? "commit";
    if (store.transaction !== undefined) {
      this.transaction = (work) =>
        this.#transaction((view) => work(ExecutionCoordinator.#over(view)));
    }
  }

  static {
    claimOn = (coordinator, jobId, input) =>
      coordinator.#claim(jobId, detached(input));
  }

  /**
   * A coordinator over a transaction's view, which no other write reaches:
   * without `transaction`, it runs its work on the view directly.
   */
  static #over(view: WorkflowStore): ExecutionCoordinator {
    return new ExecutionCoordinator({ store: withoutTransaction(view) });
  }

  /**
   * Every record, checked against each other as a snapshot is
   * (`validateOrchestratorStoreSnapshot`), as of one moment when the store
   * offers transactions.
   */
  snapshot(): Promise<OrchestratorStoreSnapshot> {
    return this.#consistent(async (store) =>
      validateOrchestratorStoreSnapshot({
        frames: await everything((page) => store.listFrames(page)),
        jobs: await everything((page) => store.listJobs(page)),
        queues: await store.listQueues(),
        runs: await everything((page) => store.listRuns(page)),
        suspensions: await everything((page) => store.listSuspensions(page)),
        version: ORCHESTRATOR_STORE_SNAPSHOT_VERSION,
      })
    );
  }

  /**
   * Puts every record of a snapshot into a store that holds none, in one
   * commit, once the snapshot validates. Rejects a store that holds a
   * record already.
   */
  async restore(snapshot: unknown): Promise<void> {
    const validated = validateOrchestratorStoreSnapshot(snapshot);
    await this.#exclusive(async (store) => {
      const held = await Promise.all([
        store.listQueues(),
        store.listJobs({ limit: 1 }).then((page) => page.items),
        store.listRuns({ limit: 1 }).then((page) => page.items),
        store.listSuspensions({ limit: 1 }).then((page) => page.items),
        store.listFrames({ limit: 1 }).then((page) => page.items),
      ]);
      if (held.some((records) => records.length > 0)) {
        throw new Error("A snapshot restores only into an empty store");
      }
      await store.commit({
        putFrames: validated.frames,
        putJobs: validated.jobs,
        putQueues: validated.queues,
        putRuns: validated.runs,
        putSuspensions: validated.suspensions,
      });
    });
  }

  createJob(input: CreateJobInput): Promise<JobRecord> {
    const id = input.id ?? generateId("jb");
    return this.#exclusive(async (store) => {
      if (await store.getJob(id)) {
        throw new RecordAlreadyExistsError("job", id);
      }
      const record = decodeJobRecord({
        definition: definedEntries(input.definition),
        id,
        input: input.input,
        links: definedEntries(input.links ?? {}),
        status: "pending",
        timestamps: {
          cancelledAt: null,
          completedAt: null,
          createdAt: Date.now(),
          failedAt: null,
        },
      });
      await store.commit({ putJobs: [record] });
      return record;
    });
  }

  getJob(id: string): Promise<JobRecord | null> {
    return this.#store.getJob(id);
  }

  updateJob(id: string, patch: UpdateJobInput): Promise<JobRecord | null> {
    return this.#exclusive(async (store) => {
      const existing = await store.getJob(id);
      if (!existing) {
        return null;
      }
      if (
        isTerminalJobStatus(existing.status) &&
        patch.status !== undefined &&
        patch.status !== existing.status
      ) {
        return existing;
      }
      const updated = decodeJobRecord({
        ...existing,
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.timestamps === undefined
          ? {}
          : { timestamps: { ...existing.timestamps, ...patch.timestamps } }),
      });
      await store.commit({ putJobs: [updated] });
      return updated;
    });
  }

  listJobs(query: JobQuery = {}): Promise<Page<JobRecord, number>> {
    return this.#consistent(async (store) => {
      const status = statusList(query.status);
      const records = await everything((page) =>
        store.listJobs({ ...page, ...(status ? { status } : {}) })
      );
      return pageRecords(
        records.filter((record) => matchesJobQuery(record, query)),
        query,
        50
      );
    });
  }

  deleteJob(id: string): Promise<void> {
    return this.#exclusive(async (store) => {
      const runs = await runsOfJob(store, id);
      if (runs.length > 0) {
        throw new RecordInUseError("job", id);
      }
      await store.commit({ deleteJobs: [id] });
    });
  }

  cancelJob(id: string): Promise<JobCancellation> {
    return this.#exclusive(async (store) => {
      const job = await store.getJob(id);
      if (!job) {
        throw new JobNotFoundError(id);
      }
      if (isTerminalJobStatus(job.status)) {
        throw new JobAlreadySettledError(id);
      }
      const jobRuns = await runsOfJob(store, id);
      const active =
        jobRuns.find((run) => isNonTerminalRunStatus(run.status)) ?? null;
      if (active === null && jobRuns.some((run) => run.status === "complete")) {
        throw new JobAlreadySettledError(id);
      }
      const pending = active ? await pendingSuspensions(store, active.id) : [];
      const cancelledAt = Date.now();
      const nextJob = decodeJobRecord({
        ...job,
        status: "cancelled",
        timestamps: { ...job.timestamps, cancelledAt },
      });
      const nextRun = active
        ? normalizeRunRecord(applyRunPatch(active, { status: "cancelled" }))
        : null;
      const suspensions = pending.map((record) =>
        cancelSuspensionRecord(record, cancelledAt)
      );
      await store.commit(
        withEvents(
          {
            putJobs: [nextJob],
            ...(nextRun ? { putRuns: [nextRun] } : {}),
            putSuspensions: suspensions,
          },
          active && nextRun ? runEvents(active, nextRun) : []
        )
      );
      return { job: nextJob, run: nextRun, suspensions };
    });
  }

  createRun(input: CreateRunInput): Promise<RunRecord> {
    const id = input.id ?? generateId("rn");
    return this.#exclusive(async (store) => {
      if (await store.getRun(id)) {
        throw new RecordAlreadyExistsError("run", id);
      }
      const unsafeLinks = input.links as RunLinks | undefined;
      if (unsafeLinks?.jobId !== undefined) {
        throw new Error(
          "Job-linked Runs must be created through claimJobRun()"
        );
      }
      const record = buildRunRecord(id, input);
      await store.commit(
        withEvents({ putRuns: [record] }, runEvents(null, record))
      );
      return record;
    });
  }

  /**
   * Starts a managed attempt of a Job: the Job becomes active and its Run
   * is filed in one commit. A Job whose earlier attempt completed is
   * settled as complete instead, and the claim is refused once that lands.
   */
  async claimJobRun(
    jobId: string,
    input: CreateJobRunInput
  ): Promise<JobRunClaim> {
    const outcome = await this.#claim(jobId, input);
    if (outcome.status === "settled") {
      throw new JobAlreadySettledError(jobId);
    }
    return outcome.claim;
  }

  /**
   * `claimJobRun` as an outcome: the claim, or that the Job was found
   * settled, as an earlier attempt completed, and was written as complete.
   * Admission uses it inside its transaction, so the settlement commits and
   * the refusal follows the commit; see `claimJobAttempt`.
   */
  #claim(jobId: string, input: CreateJobRunInput): Promise<JobRunClaimOutcome> {
    return this.#exclusive(async (store): Promise<JobRunClaimOutcome> => {
      const job = await store.getJob(jobId);
      if (!job) {
        throw new JobNotFoundError(jobId);
      }
      if (isTerminalJobStatus(job.status)) {
        throw new JobAlreadySettledError(jobId);
      }
      const jobRuns = await runsOfJob(store, jobId);
      const active = jobRuns.find((attempt) =>
        isNonTerminalRunStatus(attempt.status)
      );
      if (active) {
        throw new JobAttemptAlreadyActiveError(jobId, active.id);
      }
      if (jobRuns.some((attempt) => attempt.status === "complete")) {
        const settled = decodeJobRecord({
          ...job,
          status: "complete",
          timestamps: { ...job.timestamps, completedAt: Date.now() },
        });
        await store.commit({ putJobs: [settled] });
        return { job: settled, status: "settled" };
      }
      const runId = input.id ?? generateId("rn");
      if (await store.getRun(runId)) {
        throw new RecordAlreadyExistsError("run", runId);
      }
      const nextJob = decodeJobRecord({
        ...job,
        status: "active",
        timestamps: { ...job.timestamps, completedAt: null, failedAt: null },
      });
      const run = buildRunRecord(runId, {
        ...input,
        links: { ...(input.links ?? {}), jobId },
      });
      await store.commit(
        withEvents({ putJobs: [nextJob], putRuns: [run] }, runEvents(null, run))
      );
      return { claim: { job: nextJob, run }, status: "claimed" };
    });
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const record = await this.#store.getRun(id);
    return record ? hydrateRunRecord(record) : null;
  }

  updateRun(id: string, patch: UpdateRunInput): Promise<RunRecord | null> {
    return this.#exclusive(async (store) => {
      const stored = await store.getRun(id);
      if (!stored) {
        return null;
      }
      const existing = hydrateRunRecord(stored);
      if (
        isTerminalRunStatus(existing.status) &&
        patch.status !== undefined &&
        patch.status !== existing.status
      ) {
        return existing;
      }
      const updated = normalizeRunRecord(applyRunPatch(existing, patch));
      await store.commit(
        withEvents({ putRuns: [updated] }, runEvents(existing, updated))
      );
      return updated;
    });
  }

  listRuns(query: RunQuery = {}): Promise<Page<RunRecord, number>> {
    return this.#consistent(async (store) => {
      const status = statusList(query.status);
      const records = await everything((page) =>
        store.listRuns({
          ...page,
          ...(query.queueId === undefined ? {} : { queueId: query.queueId }),
          ...(status ? { status } : {}),
        })
      );
      return pageRecords(
        records
          .map(hydrateRunRecord)
          .filter((record) => matchesRunQuery(record, query)),
        { order: "newest", ...query },
        3
      );
    });
  }

  deleteRun(id: string): Promise<void> {
    return this.#exclusive(async (store) => {
      const [run, suspensions, frames] = await Promise.all([
        store.getRun(id),
        store.listSuspensions({ limit: 1, runId: id }),
        canonicalFrames(store, id),
      ]);
      if (suspensions.items.length > 0 || frames.length > 0) {
        throw new RecordInUseError("run", id);
      }
      // A Run that is not filed is not removed: the delete changes nothing.
      await store.commit(
        withEvents(
          { deleteRuns: [id] },
          runEvents(run && hydrateRunRecord(run), null)
        )
      );
    });
  }

  findRecoverableRuns(queueId: string): Promise<RecoverableRun[]> {
    return this.#consistent(async (store) => {
      const runs = await everything((page) =>
        store.listRuns({ ...page, queueId, status: LIVE_RUN_STATUSES })
      );
      return sortRecords(runs.map(hydrateRunRecord), "newest").map(
        rowToRecoverable
      );
    });
  }

  createSuspension(input: CreateSuspensionInput): Promise<SuspensionRecord> {
    const id = input.id ?? generateId("su");
    return this.#exclusive(async (store) => {
      if (await store.getSuspension(id)) {
        throw new RecordAlreadyExistsError("suspension", id);
      }
      if (!(await store.getRun(input.runId))) {
        throw new RunNotFoundError(input.runId);
      }
      const record = pendingSuspension(id, input, input.occurrence ?? 0);
      await store.commit({ putSuspensions: [record] });
      return record;
    });
  }

  /**
   * Parks a Run at one Suspension occurrence: the Run becomes suspended and
   * the Suspension is filed in one commit. The same occurrence parked again
   * returns the Suspension already filed, and refuses a different request.
   */
  parkSuspension(
    input: CreateSuspensionInput,
    runPatch: Omit<UpdateRunInput, "status"> = {}
  ): Promise<SuspensionParking> {
    const occurrence = input.occurrence ?? 0;
    return this.#exclusive(async (store) => {
      const storedRun = await store.getRun(input.runId);
      if (!storedRun) {
        throw new RunNotFoundError(input.runId);
      }
      const run = hydrateRunRecord(storedRun);
      const existing = (
        await everything((page) =>
          store.listSuspensions({ ...page, runId: input.runId })
        )
      ).find(
        (record) =>
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
        return { created: false, suspension: existing };
      }
      const id = input.id ?? generateId("su");
      if (await store.getSuspension(id)) {
        throw new RecordAlreadyExistsError("suspension", id);
      }
      const suspension = pendingSuspension(id, input, occurrence);
      const nextRun = normalizeRunRecord(
        applyRunPatch(run, { ...runPatch, status: "suspended" })
      );
      await store.commit(
        withEvents(
          { putRuns: [nextRun], putSuspensions: [suspension] },
          runEvents(run, nextRun)
        )
      );
      return { created: true, suspension };
    });
  }

  getSuspension(id: string): Promise<SuspensionRecord | null> {
    return this.#store.getSuspension(id);
  }

  listSuspensions(
    query: SuspensionQuery = {}
  ): Promise<Page<SuspensionRecord, number>> {
    return this.#consistent(async (store) => {
      const status = statusList(query.status);
      const records = await everything((page) =>
        store.listSuspensions({
          ...page,
          ...(query.runId === undefined ? {} : { runId: query.runId }),
          ...(status ? { status } : {}),
        })
      );
      return pageRecords(
        records.filter((record) => matchesSuspensionQuery(record, query)),
        query,
        50
      );
    });
  }

  /**
   * Resolves or cancels a pending Suspension at the revision the caller
   * read, and moves its Run on, in one commit.
   */
  settleSuspension(
    id: string,
    input: SettleSuspensionInput
  ): Promise<SuspensionSettlement> {
    return this.#exclusive(async (store) => {
      const suspension = await store.getSuspension(id);
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
      const storedRun = await store.getRun(suspension.runId);
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
      await store.commit(
        withEvents(
          { putRuns: [nextRun], putSuspensions: [nextSuspension] },
          runEvents(run, nextRun)
        )
      );
      return { run: nextRun, suspension: nextSuspension };
    });
  }

  cancelRunSuspensions(
    runId: string,
    runPatch: Omit<UpdateRunInput, "status"> = {}
  ): Promise<SuspensionCancellation> {
    return this.#cancelRun(runId, runPatch, false);
  }

  cancelRun(
    runId: string,
    runPatch: Omit<UpdateRunInput, "status"> = {}
  ): Promise<SuspensionCancellation> {
    return this.#cancelRun(runId, runPatch, true);
  }

  deleteSuspension(id: string): Promise<void> {
    return this.#exclusive(async (store) => {
      const suspension = await store.getSuspension(id);
      if (suspension) {
        const referenced = (
          await canonicalFrames(store, suspension.runId)
        ).some(
          (frame) =>
            frame.payload.kind === "suspension" &&
            frame.payload.value.id === suspension.id
        );
        if (referenced) {
          throw new RecordInUseError("suspension", id);
        }
      }
      await store.commit({ deleteSuspensions: [id] });
    });
  }

  /**
   * Appends one frame at the next cursor of the Run's journal. A terminal
   * lifecycle frame is kept once: appending another returns the first.
   */
  appendRunFrame(input: AppendRunFrameInput): Promise<RunFrame> {
    return this.#exclusive(async (store) => {
      if (!(await store.getRun(input.runId))) {
        throw new RunNotFoundError(input.runId);
      }
      const frames = await canonicalFrames(store, input.runId);
      if (isTerminalFramePayload(input.payload)) {
        const terminal = frames.find((frame) =>
          isTerminalFramePayload(frame.payload)
        );
        if (terminal) {
          return terminal;
        }
      }
      return appendFrame(store, input.runId, frames, input.payload, input.at);
    });
  }

  /**
   * Appends one effect-claim frame per `(runId, key)`: the frame for the
   * first claim, and `null` for every later one.
   */
  claimRunEffect(input: ClaimRunEffectInput): Promise<RunFrame | null> {
    return this.#exclusive(async (store) => {
      const payload = runEffectClaimPayload(input);
      if (!(await store.getRun(input.runId))) {
        throw new RunNotFoundError(input.runId);
      }
      const frames = await canonicalFrames(store, input.runId);
      if (frames.some((frame) => isRunEffectClaim(frame, input.key))) {
        return null;
      }
      return appendFrame(store, input.runId, frames, payload, input.at);
    });
  }

  listRunFrames(runId: string, after = -1): Promise<RunFrame[]> {
    return this.#consistent(async (store) => {
      if (!(await store.getRun(runId))) {
        throw new RunNotFoundError(runId);
      }
      return (await canonicalFrames(store, runId)).filter(
        (frame) => frame.cursor > after
      );
    });
  }

  listFrames(query: RunFramePageQuery = {}): Promise<Page<RunFrame, number>> {
    return this.#consistent(async (store) => {
      const direction = query.order === "newest" ? -1 : 1;
      const frames = (await journals(store, query.runId))
        .flatMap(({ frames: values }) => values)
        .filter(
          (frame) => query.after === undefined || frame.cursor > query.after
        )
        .sort(
          (left, right) =>
            direction *
            (left.at - right.at ||
              left.runId.localeCompare(right.runId) ||
              left.cursor - right.cursor)
        );
      return pageValues(frames, query, 100);
    });
  }

  countFrames(
    query: Pick<RunFramePageQuery, "runId" | "after"> = {}
  ): Promise<number> {
    return this.#consistent(async (store) =>
      (await journals(store, query.runId)).reduce(
        (total, { frames }) =>
          total +
          frames.filter(
            (frame) => query.after === undefined || frame.cursor > query.after
          ).length,
        0
      )
    );
  }

  listFrameRuns(query: PageQuery = {}): Promise<Page<FrameRun, number>> {
    return this.#consistent(async (store) => {
      const direction = query.order === "oldest" ? 1 : -1;
      const values = (await journals(store))
        .flatMap(({ frames, runId }): FrameRun[] => {
          const last = frames.at(-1);
          return last === undefined ? [] : [{ lastAt: last.at, runId }];
        })
        .sort(
          (left, right) =>
            direction *
            (left.lastAt - right.lastAt ||
              left.runId.localeCompare(right.runId))
        );
      return pageValues(values, query, 3);
    });
  }

  countFrameRuns(): Promise<number> {
    return this.#consistent(
      async (store) =>
        (await journals(store)).filter(({ frames }) => frames.length > 0).length
    );
  }

  deleteRunFrames(runId: string): Promise<void> {
    return this.#exclusive((store) =>
      store.commit({ deleteRunFrames: [runId] })
    );
  }

  /** The Queue filed under the id, or this one when none is: the first writer wins. */
  ensureQueue(input: EnsureQueueInput): Promise<QueueRecord> {
    return this.#exclusive(async (store) => {
      const record: QueueRecord = {
        createdAt: Date.now(),
        extensions: createExtensions(input.extensions),
        id: input.id,
        lastError: null,
        name: input.name,
        status: "active",
      };
      const existing = await store.getQueue(record.id);
      if (existing) {
        return existing;
      }
      await store.commit({ putQueues: [record] });
      return record;
    });
  }

  async listQueues(): Promise<QueueRecord[]> {
    return [...(await this.#store.listQueues())];
  }

  updateQueue(
    id: string,
    patch: UpdateQueueInput
  ): Promise<QueueRecord | null> {
    return this.#exclusive(async (store) => {
      const existing = await store.getQueue(id);
      if (!existing) {
        return null;
      }
      const updated: QueueRecord = {
        ...existing,
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.lastError === undefined
          ? {}
          : { lastError: patch.lastError }),
        ...(patch.extensions === undefined
          ? {}
          : {
              extensions: mergeExtensions(
                existing.extensions,
                patch.extensions
              ),
            }),
      };
      await store.commit({ putQueues: [updated] });
      return updated;
    });
  }

  /**
   * Cancels a Run and settles each of its pending Suspensions as cancelled,
   * in one commit. `rejectSettled` refuses a Run that already ended; without
   * it, an ended Run is returned as it is, unless it was cancelled.
   */
  #cancelRun(
    runId: string,
    runPatch: Omit<UpdateRunInput, "status">,
    rejectSettled: boolean
  ): Promise<SuspensionCancellation> {
    return this.#exclusive(async (store) => {
      const storedRun = await store.getRun(runId);
      if (!storedRun) {
        throw new RunNotFoundError(runId);
      }
      const run = hydrateRunRecord(storedRun);
      if (isTerminalRunStatus(run.status)) {
        if (rejectSettled) {
          throw new RunAlreadySettledError(runId);
        }
        if (run.status !== "cancelled") {
          return { run, suspensions: [] };
        }
      }
      const pending = await pendingSuspensions(store, runId);
      const settledAt = Date.now();
      const suspensions = pending.map((record) =>
        cancelSuspensionRecord(record, settledAt)
      );
      const nextRun = normalizeRunRecord(
        applyRunPatch(run, { ...runPatch, status: "cancelled" })
      );
      await store.commit(
        withEvents(
          { putRuns: [nextRun], putSuspensions: suspensions },
          runEvents(run, nextRun)
        )
      );
      return { run: nextRun, suspensions };
    });
  }

  /**
   * Runs one read-modify-write so that no other change lands inside it:
   * through the store's transaction when it offers one, and in turn with
   * this coordinator's other changes otherwise.
   */
  #exclusive<T>(work: (store: WorkflowStore) => Promise<T>): Promise<T> {
    if (this.#store.transaction === undefined) {
      return this.#serialized(() => work(this.#store));
    }
    return this.#transaction(work);
  }

  /** A read of several store reads, as of one moment where the store allows it. */
  #consistent<T>(work: (store: WorkflowStore) => Promise<T>): Promise<T> {
    if (this.#store.transaction === undefined) {
      return work(this.#store);
    }
    return this.#transaction(work);
  }

  #transaction<T>(work: (view: WorkflowStore) => Promise<T>): Promise<T> {
    const store = this.#store;
    if (store.transaction === undefined) {
      throw new Error("The workflow store offers no transaction");
    }
    return store.transaction(work);
  }

  /**
   * One change at a time in this coordinator. Not used over a store with
   * transactions: the store's own queue orders those, and a call from
   * inside one is refused there at once instead of waiting here forever.
   */
  #serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work, work);
    this.#tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

/**
 * Refuses a store whose commits a host transaction may still roll back, for
 * a runtime (`Orchestrator`, `Queue`) that starts workflow code, dispatches,
 * and signals cancellations once a commit resolves: it would act on records
 * a rollback then removes.
 */
export function requireDurableStore(
  store: OrchestratorStore,
  runtime: string
): void {
  if (store.durability === "host") {
    throw new Error(
      `${runtime} cannot run over a store whose commits a host transaction may roll back (durability "host"): it would run workflow code for Runs a rollback removes. Run it over a store on the database itself, outside the host's transaction.`
    );
  }
}

/**
 * Makes every public method of `prototype` take its arguments as they stand
 * when it is called: one deep copy, with byte memory unshared, taken before
 * anything else runs, and the only one the method sees. So no command reads
 * a caller's input after an await, and a command added later is covered
 * without asking. A value the copy refuses (a function, say), or an
 * argument with fields it would not keep (`refuseHiddenFields`), rejects
 * the call.
 */
function takeArgumentsWhenCalled(prototype: object): void {
  for (const name of Object.getOwnPropertyNames(prototype)) {
    const method: unknown = Reflect.get(prototype, name);
    if (name === "constructor" || typeof method !== "function") {
      continue;
    }
    Object.defineProperty(prototype, name, {
      configurable: true,
      value(this: unknown, ...args: unknown[]): unknown {
        let owned: unknown[];
        try {
          for (const [index, arg] of args.entries()) {
            refuseHiddenFields(name, index, arg);
          }
          owned = detached(args);
        } catch (error) {
          return Promise.reject(error);
        }
        return Reflect.apply(method, this, owned);
      },
      writable: true,
    });
  }
}

takeArgumentsWhenCalled(ExecutionCoordinator.prototype);

/**
 * Refuses an argument object the copy would read less of than it shows:
 * one made by a class or another prototype (its getters live there), or
 * one with an own property that is not enumerable. The copy keeps only own
 * enumerable properties, so such a field would be lost without a word.
 */
function refuseHiddenFields(method: string, index: number, arg: unknown): void {
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    return;
  }
  const prototype: unknown = Object.getPrototypeOf(arg);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertyNames(arg).length !== Object.keys(arg).length
  ) {
    throw new TypeError(
      `ExecutionCoordinator.${method} takes plain objects: argument ${index + 1} has fields a copy would not keep (a getter on its prototype, or an own property that is not enumerable)`
    );
  }
}

/**
 * What a claim of a managed Job attempt did: claimed the attempt, or found
 * the Job settled (an earlier attempt completed) and wrote it as complete.
 */
type JobRunClaimOutcome =
  | { readonly status: "claimed"; readonly claim: JobRunClaim }
  | { readonly status: "settled"; readonly job: JobRecord };

/**
 * Claims a managed attempt of a Job through `store` without raising on a
 * settled Job, for a caller inside a transaction that must keep the
 * settlement: admission returns the outcome out of its transaction, lets
 * it commit, and refuses afterwards. Over an `ExecutionCoordinator` the
 * settled case is a value; over any other `OrchestratorStore`, which offers
 * only `claimJobRun`, it stays the rejection that store raises.
 */
export function claimJobAttempt(
  store: OrchestratorStore,
  jobId: string,
  input: CreateJobRunInput
): Promise<JobRunClaimOutcome> {
  if (store instanceof ExecutionCoordinator) {
    return claimOn(store, jobId, input);
  }
  return store
    .claimJobRun(jobId, input)
    .then((claim) => ({ claim, status: "claimed" as const }));
}

/** `view` without `transaction`: a coordinator over it runs its work directly. */
function withoutTransaction(view: WorkflowStore): WorkflowStore {
  return {
    commit: (write) => view.commit(write),
    durability: view.durability ?? "host",
    getJob: (id) => view.getJob(id),
    getQueue: (id) => view.getQueue(id),
    getRun: (id) => view.getRun(id),
    getSuspension: (id) => view.getSuspension(id),
    listFrames: (query) => view.listFrames(query),
    listJobs: (query) => view.listJobs(query),
    listQueues: () => view.listQueues(),
    listRuns: (query) => view.listRuns(query),
    listSuspensions: (query) => view.listSuspensions(query),
  };
}

/** Every record of a list read, one store page after another. */
async function everything<T>(
  list: (page: WorkflowStorePageQuery) => Promise<WorkflowStorePage<T>>
): Promise<T[]> {
  const items: T[] = [];
  let after: number | undefined;
  for (;;) {
    const page = await list(
      after === undefined
        ? { limit: STORE_PAGE_LIMIT }
        : { after, limit: STORE_PAGE_LIMIT }
    );
    items.push(...page.items);
    if (page.next === undefined) {
      return items;
    }
    after = page.next;
  }
}

/** A Job's Runs, hydrated, linked by their own links or legacy metadata. */
async function runsOfJob(
  store: WorkflowStore,
  jobId: string
): Promise<RunRecord[]> {
  return (await everything((page) => store.listRuns(page)))
    .map(hydrateRunRecord)
    .filter((run) => run.links?.jobId === jobId);
}

/** A Run's pending Suspensions, by id. */
async function pendingSuspensions(
  store: WorkflowStore,
  runId: string
): Promise<SuspensionRecord[]> {
  return (
    await everything((page) =>
      store.listSuspensions({ ...page, runId, status: ["pending"] })
    )
  ).sort((left, right) => left.id.localeCompare(right.id));
}

/** A Run's journal, checked as one sequence. */
async function canonicalFrames(
  store: WorkflowStore,
  runId: string
): Promise<RunFrame[]> {
  return decodeRunFrameSequence(
    runId,
    await everything((page) => store.listFrames({ ...page, runId }))
  );
}

/**
 * The journal of each Run the store holds, or of the one Run named, each
 * checked as one sequence. Frames of a Run the store does not hold are left
 * out; naming such a Run is refused.
 */
async function journals(
  store: WorkflowStore,
  runId?: string
): Promise<{ readonly frames: RunFrame[]; readonly runId: string }[]> {
  if (runId !== undefined) {
    if (!(await store.getRun(runId))) {
      throw new RunNotFoundError(runId);
    }
    return [{ frames: await canonicalFrames(store, runId), runId }];
  }
  const grouped = new Map<string, RunFrame[]>();
  for (const frame of await everything((page) => store.listFrames(page))) {
    const frames = grouped.get(frame.runId) ?? [];
    frames.push(frame);
    grouped.set(frame.runId, frames);
  }
  const runs = await everything((page) => store.listRuns(page));
  return runs.map((run) => ({
    frames: decodeRunFrameSequence(run.id, grouped.get(run.id) ?? []),
    runId: run.id,
  }));
}

/** Files the next frame of a Run's checked journal and returns it. */
async function appendFrame(
  store: WorkflowStore,
  runId: string,
  frames: readonly RunFrame[],
  payload: RunFramePayload,
  at: number | undefined
): Promise<RunFrame> {
  const last = frames.at(-1);
  const frame = decodeRunFrame({
    at: at ?? Date.now(),
    cursor: last === undefined ? 0 : last.cursor + 1,
    payload,
    runId,
  });
  decodeRunFrameSequence(runId, [...frames, frame]);
  await store.commit({ putFrames: [frame] });
  return frame;
}

function pendingSuspension(
  id: string,
  input: CreateSuspensionInput,
  occurrence: number
): SuspensionRecord {
  return decodeSuspensionRecord({
    id,
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
}

function statusList<T extends string>(
  status: T | readonly T[] | undefined
): readonly T[] | undefined {
  if (status === undefined) {
    return;
  }
  return typeof status === "string" ? [status] : status;
}

/** Records by creation time, then id; newest first when asked. */
function sortRecords<
  T extends { readonly id: string; readonly timestamps: { createdAt: number } },
>(records: readonly T[], order: "newest" | "oldest" | undefined): T[] {
  const direction = order === "newest" ? -1 : 1;
  return [...records].sort(
    (left, right) =>
      direction *
      (left.timestamps.createdAt - right.timestamps.createdAt ||
        left.id.localeCompare(right.id))
  );
}

function pageRecords<
  T extends { readonly id: string; readonly timestamps: { createdAt: number } },
>(
  records: readonly T[],
  query: {
    readonly limit?: number;
    readonly cursor?: number;
    readonly order?: "newest" | "oldest";
  },
  fallback: number
): Page<T, number> {
  return pageValues(sortRecords(records, query.order), query, fallback);
}

function pageValues<T>(
  values: readonly T[],
  query: { readonly limit?: number; readonly cursor?: number },
  fallback: number
): Page<T, number> {
  const limit = query.limit ?? fallback;
  const offset = query.cursor ?? 0;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 200) {
    throw new Error("[execution] page limit must be an integer from 1 to 200");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("[execution] page offset must be a non-negative integer");
  }
  const items = values.slice(offset, offset + limit);
  const hasMore = values.length > offset + items.length;
  return {
    items,
    total: values.length,
    ...(hasMore ? { nextCursor: offset + items.length } : {}),
  };
}

function matchesStatus<T extends string>(
  status: T,
  query: T | readonly T[] | undefined
): boolean {
  return statusList(query)?.includes(status) ?? true;
}

function matchesLinks<T extends object>(
  links: T | undefined,
  query: Partial<T> | undefined
): boolean {
  if (query === undefined) {
    return true;
  }
  return Object.entries(query).every(
    ([key, value]) =>
      (links as Readonly<Record<string, unknown>> | undefined)?.[key] === value
  );
}

function matchesJobQuery(record: JobRecord, query: JobQuery): boolean {
  return (
    matchesStatus<JobStatus>(record.status, query.status) &&
    (query.definition === undefined ||
      record.definition.name === query.definition) &&
    matchesLinks(record.links, query.links)
  );
}

function matchesRunQuery(record: RunRecord, query: RunQuery): boolean {
  const search = query.search?.trim().toLocaleLowerCase();
  return (
    (query.queueId === undefined || record.queueId === query.queueId) &&
    (!search ||
      [
        record.id,
        record.queueId,
        record.step,
        record.definition?.name,
        record.links?.sessionId,
        record.links?.invocationId,
        record.links?.subjectId,
      ].some(
        (value) => value?.toLocaleLowerCase().includes(search) === true
      )) &&
    matchesStatus<RunStatus>(record.status, query.status) &&
    Object.entries(query.tags ?? {}).every(
      ([key, value]) => record.tags[key] === value
    ) &&
    (query.definition === undefined ||
      record.definition?.name === query.definition) &&
    matchesLinks(record.links ?? {}, query.links)
  );
}

function matchesSuspensionQuery(
  record: SuspensionRecord,
  query: SuspensionQuery
): boolean {
  return (
    (query.runId === undefined || record.runId === query.runId) &&
    (query.kind === undefined || record.kind === query.kind) &&
    (query.name === undefined || record.name === query.name) &&
    (query.occurrence === undefined ||
      record.occurrence === query.occurrence) &&
    (query.stepPath === undefined ||
      sameStringArray(record.stepPath, query.stepPath)) &&
    matchesStatus<SuspensionStatus>(record.status, query.status)
  );
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

/**
 * A copy of `value` without its fields that hold `undefined`, which a store
 * may not keep. Anything but a plain object is returned as it is, for the
 * record's decoder to refuse.
 */
function definedEntries<T>(value: T): T {
  if (!isUnknownRecord(value)) {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      defineOwnEntry(copy, key, cloneValue(entry));
    }
  }
  return copy as T;
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

/** A Run with the definition and links a legacy record keeps only in its metadata. */
function hydrateRunRecord(record: RunRecord): RunRecord {
  const execution = record.metadata[EXECUTION_METADATA_KEY];
  if (!isUnknownRecord(execution)) {
    return normalizeRunRecord(record);
  }
  return normalizeRunRecord({
    ...record,
    ...(record.definition === undefined
      ? { definition: execution.definition as DefinitionReference | undefined }
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
    ...(input.definition === undefined ? {} : { definition: input.definition }),
    ...(input.links === undefined ? {} : { links: input.links }),
  });
}

/**
 * A Run as the store keeps it: JSON-safe data normalized, and `definition`
 * and `links` either present without `undefined` entries or left out.
 * Every field the Run does not declare is kept.
 */
function normalizeRunRecord(record: RunRecord): RunRecord {
  const { definition, links, ...rest } = record;
  const normalized: RunRecord = {
    ...rest,
    extensions: createExtensions(record.extensions),
    input: normalizeJsonValue(record.input),
    metadata: normalizeJsonValue(record.metadata) as Record<string, unknown>,
    output: normalizeJsonValue(record.output),
    snapshot: normalizeJsonValue({
      ...record.snapshot,
      input: normalizeJsonValue(record.snapshot.input),
    }) as unknown as WorkflowSnapshot,
    ...(definition === undefined
      ? {}
      : { definition: definedEntries(definition) }),
    ...(links === undefined ? {} : { links: definedEntries(links) }),
  };
  decodeRunRecord(runCheckedAs(normalized));
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
        defineOwnEntry(normalized, key, normalizeJsonValue(entry, ancestors));
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
  const { value } = payload;
  if (!isUnknownRecord(value)) {
    return false;
  }
  const { event } = value;
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

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "complete" || status === "failed" || status === "cancelled";
}

function isNonTerminalRunStatus(status: RunStatus): boolean {
  return LIVE_RUN_STATUSES.includes(status);
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
    timestamps: { ...record.timestamps, cancelledAt, resolvedAt: null },
  });
}

function emptyWorkflowSnapshot(): WorkflowSnapshot {
  return { cursor: null, input: null, name: "", steps: [] };
}
