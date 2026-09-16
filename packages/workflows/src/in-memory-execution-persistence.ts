import { RunNotFoundError } from "./errors";
import { AbstractOrchestratorStore } from "./execution-coordinator";
import type {
  JobRecord,
  RunFrame,
  RunRecord,
  SuspensionRecord,
} from "./execution-records";
import type {
  ExecutionRepository,
  JobCancellationCommit,
  JobQuery,
  JobRunClaimCommit,
  JobRunClaimOutcome,
  Page,
  QueueRecord,
  RepositoryCommitOutcome,
  RunPage,
  RunQuery,
  SuspensionCancellationCommit,
  SuspensionParkingCommit,
  SuspensionQuery,
  SuspensionSettlementCommit,
} from "./execution-repository";
import type { InMemoryExecutionPersistence } from "./persistence";
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
import type { OrchestratorStoreSnapshot } from "./store-snapshot";
import {
  ORCHESTRATOR_STORE_SNAPSHOT_VERSION,
  validateOrchestratorStoreSnapshot,
} from "./store-snapshot";

/** Zero-configuration reference persistence for local and test use. */
export class InMemoryOrchestratorStore extends AbstractOrchestratorStore {
  readonly #jobs = new Map<string, JobRecord>();
  readonly #runs = new Map<string, RunRecord>();
  readonly #suspensions = new Map<string, SuspensionRecord>();
  readonly #queues = new Map<string, QueueRecord>();
  readonly #frames = new Map<string, RunFrame[]>();

  constructor(options: { readonly snapshot?: unknown } = {}) {
    super();
    if (options.snapshot === undefined) {
      return;
    }

    const snapshot = validateOrchestratorStoreSnapshot(options.snapshot);
    for (const queue of snapshot.queues) {
      this.#queues.set(queue.id, clone(queue));
    }
    for (const job of snapshot.jobs) {
      this.#jobs.set(job.id, clone(job));
    }
    for (const run of snapshot.runs) {
      this.#runs.set(run.id, clone(run));
    }
    for (const suspension of snapshot.suspensions) {
      this.#suspensions.set(suspension.id, clone(suspension));
    }
    for (const frame of snapshot.frames) {
      const frames = this.#frames.get(frame.runId) ?? [];
      frames.push(clone(frame));
      this.#frames.set(frame.runId, frames);
    }
  }

  snapshot(): OrchestratorStoreSnapshot {
    return validateOrchestratorStoreSnapshot(
      JSON.parse(
        JSON.stringify({
          frames: [...this.#frames.values()].flat(),
          jobs: [...this.#jobs.values()],
          queues: [...this.#queues.values()],
          runs: [...this.#runs.values()],
          suspensions: [...this.#suspensions.values()],
          version: ORCHESTRATOR_STORE_SNAPSHOT_VERSION,
        })
      )
    );
  }

  protected readJob(id: string): Promise<JobRecord | null> {
    return Promise.resolve(cloneOptional(this.#jobs.get(id)));
  }

  protected writeJob(record: JobRecord): Promise<void> {
    this.#jobs.set(record.id, clone(record));
    return Promise.resolve();
  }

  protected readJobs(): Promise<JobRecord[]> {
    return Promise.resolve([...this.#jobs.values()].map(clone));
  }

  protected queryJobs(query: JobQuery): Promise<Page<JobRecord>> {
    return Promise.resolve(
      pageRecords(
        [...this.#jobs.values()].filter((record) =>
          this.matchesJobQuery(record, query)
        ),
        query,
        50,
        (record) => record.timestamps.createdAt
      )
    );
  }

  protected removeJob(id: string): Promise<void> {
    this.#jobs.delete(id);
    return Promise.resolve();
  }

  protected readRun(id: string): Promise<RunRecord | null> {
    return Promise.resolve(cloneOptional(this.#runs.get(id)));
  }

  protected writeRun(record: RunRecord): Promise<void> {
    this.#runs.set(record.id, clone(record));
    return Promise.resolve();
  }

  protected readRuns(): Promise<RunRecord[]> {
    return Promise.resolve([...this.#runs.values()].map(clone));
  }

  protected queryRuns(query: RunQuery): Promise<RunPage> {
    const records = [...this.#runs.values()]
      .map((record) => this.hydrateStoredRun(record))
      .filter((record) => this.matchesRunQuery(record, query));
    return Promise.resolve({
      ...pageRecords(
        records,
        { order: "newest", ...query },
        3,
        (record) => record.timestamps.createdAt
      ),
      total: records.length,
    });
  }

  protected removeRun(id: string): Promise<void> {
    this.#runs.delete(id);
    return Promise.resolve();
  }

  protected readSuspension(id: string): Promise<SuspensionRecord | null> {
    return Promise.resolve(cloneOptional(this.#suspensions.get(id)));
  }

  protected writeSuspension(record: SuspensionRecord): Promise<void> {
    this.#suspensions.set(record.id, clone(record));
    return Promise.resolve();
  }

  protected readSuspensions(): Promise<SuspensionRecord[]> {
    return Promise.resolve([...this.#suspensions.values()].map(clone));
  }

  protected querySuspensions(
    query: SuspensionQuery
  ): Promise<Page<SuspensionRecord>> {
    return Promise.resolve(
      pageRecords(
        [...this.#suspensions.values()].filter((record) =>
          this.matchesSuspensionQuery(record, query)
        ),
        query,
        50,
        (record) => record.timestamps.createdAt
      )
    );
  }

  protected removeSuspension(id: string): Promise<void> {
    this.#suspensions.delete(id);
    return Promise.resolve();
  }

  protected readQueue(id: string): Promise<QueueRecord | null> {
    return Promise.resolve(cloneOptional(this.#queues.get(id)));
  }

  protected writeQueue(record: QueueRecord): Promise<void> {
    this.#queues.set(record.id, clone(record));
    return Promise.resolve();
  }

  protected readQueues(): Promise<QueueRecord[]> {
    return Promise.resolve([...this.#queues.values()].map(clone));
  }

  protected writeFrame(frame: RunFrame): Promise<void> {
    const frames = this.#frames.get(frame.runId) ?? [];
    frames.push(clone(frame));
    this.#frames.set(frame.runId, frames);
    return Promise.resolve();
  }

  protected readFrames(runId: string): Promise<RunFrame[]> {
    return Promise.resolve((this.#frames.get(runId) ?? []).map(clone));
  }

  protected removeFrames(runId: string): Promise<void> {
    this.#frames.delete(runId);
    return Promise.resolve();
  }

  protected override writeSuspensionSettlement(input: {
    previousSuspension: SuspensionRecord;
    nextSuspension: SuspensionRecord;
    previousRun: RunRecord;
    nextRun: RunRecord;
  }): Promise<void> {
    this.#runs.set(input.nextRun.id, clone(input.nextRun));
    this.#suspensions.set(input.nextSuspension.id, clone(input.nextSuspension));
    return Promise.resolve();
  }

  protected override writeSuspensionParking(input: {
    suspension: SuspensionRecord;
    run: RunRecord;
  }): Promise<void> {
    this.#runs.set(input.run.id, clone(input.run));
    this.#suspensions.set(input.suspension.id, clone(input.suspension));
    return Promise.resolve();
  }

  protected override writeSuspensionCancellation(input: {
    previousRun: RunRecord;
    nextRun: RunRecord;
    previousSuspensions: readonly SuspensionRecord[];
    nextSuspensions: readonly SuspensionRecord[];
  }): Promise<void> {
    this.#runs.set(input.nextRun.id, clone(input.nextRun));
    for (const suspension of input.nextSuspensions) {
      this.#suspensions.set(suspension.id, clone(suspension));
    }
    return Promise.resolve();
  }

  protected override writeJobRunClaim(input: {
    previousJob: JobRecord;
    nextJob: JobRecord;
    run: RunRecord;
  }): Promise<void> {
    this.#jobs.set(input.nextJob.id, clone(input.nextJob));
    this.#runs.set(input.run.id, clone(input.run));
    return Promise.resolve();
  }

  protected override writeJobCancellation(input: {
    previousJob: JobRecord;
    nextJob: JobRecord;
    previousRun: RunRecord | null;
    nextRun: RunRecord | null;
    previousSuspensions: readonly SuspensionRecord[];
    nextSuspensions: readonly SuspensionRecord[];
  }): Promise<void> {
    this.#jobs.set(input.nextJob.id, clone(input.nextJob));
    if (input.nextRun) {
      this.#runs.set(input.nextRun.id, clone(input.nextRun));
    }
    for (const suspension of input.nextSuspensions) {
      this.#suspensions.set(suspension.id, clone(suspension));
    }
    return Promise.resolve();
  }
}

class InMemoryExecutionState {
  readonly jobs = new Map<string, JobRecord>();
  readonly runs = new Map<string, RunRecord>();
  readonly suspensions = new Map<string, SuspensionRecord>();
  readonly queues = new Map<string, QueueRecord>();
  readonly frames = new Map<string, RunFrame[]>();
  readonly mutationTails = new Map<string, Promise<void>>();

  constructor(snapshotInput?: unknown) {
    if (snapshotInput === undefined) {
      return;
    }
    const snapshot = validateOrchestratorStoreSnapshot(snapshotInput);
    for (const queue of snapshot.queues) {
      this.queues.set(queue.id, clone(queue));
    }
    for (const job of snapshot.jobs) {
      this.jobs.set(job.id, clone(job));
    }
    for (const run of snapshot.runs) {
      this.runs.set(run.id, clone(run));
    }
    for (const suspension of snapshot.suspensions) {
      this.suspensions.set(suspension.id, clone(suspension));
    }
    for (const frame of snapshot.frames) {
      const frames = this.frames.get(frame.runId) ?? [];
      frames.push(decodeRunFrame(frame));
      this.frames.set(frame.runId, frames);
    }
  }

  snapshot(): OrchestratorStoreSnapshot {
    return validateOrchestratorStoreSnapshot({
      frames: [...this.frames.values()].flat(),
      jobs: [...this.jobs.values()],
      queues: [...this.queues.values()],
      runs: [...this.runs.values()],
      suspensions: [...this.suspensions.values()],
      version: ORCHESTRATOR_STORE_SNAPSHOT_VERSION,
    });
  }

  async lock<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.mutationTails.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.mutationTails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.mutationTails.get(key) === tail) {
        this.mutationTails.delete(key);
      }
    }
  }
}

export class InMemoryExecutionRepository implements ExecutionRepository {
  constructor(private readonly state: InMemoryExecutionState) {}

  getJob(id: string): Promise<JobRecord | null> {
    return Promise.resolve(cloneOptional(this.state.jobs.get(id)));
  }

  putJob(record: JobRecord): Promise<void> {
    this.state.jobs.set(record.id, clone(record));
    return Promise.resolve();
  }

  listJobRecords(query: JobQuery = {}): Promise<Page<JobRecord>> {
    return Promise.resolve(
      pageRecords(
        [...this.state.jobs.values()].filter((record) =>
          matchesJobQuery(record, query)
        ),
        query,
        50,
        (record) => record.timestamps.createdAt
      )
    );
  }

  deleteJobRecord(id: string): Promise<void> {
    this.state.jobs.delete(id);
    return Promise.resolve();
  }

  getRun(id: string): Promise<RunRecord | null> {
    return Promise.resolve(cloneOptional(this.state.runs.get(id)));
  }

  putRun(record: RunRecord): Promise<void> {
    this.state.runs.set(record.id, clone(record));
    return Promise.resolve();
  }

  listRunRecords(query: RunQuery = {}): Promise<RunPage> {
    const records = [...this.state.runs.values()].filter((record) =>
      matchesRunQuery(record, query)
    );
    return Promise.resolve({
      ...pageRecords(
        records,
        { order: "newest", ...query },
        3,
        (record) => record.timestamps.createdAt
      ),
      total: records.length,
    });
  }

  deleteRunRecord(id: string): Promise<void> {
    this.state.runs.delete(id);
    return Promise.resolve();
  }

  getSuspension(id: string): Promise<SuspensionRecord | null> {
    return Promise.resolve(cloneOptional(this.state.suspensions.get(id)));
  }

  putSuspension(record: SuspensionRecord): Promise<void> {
    this.state.suspensions.set(record.id, clone(record));
    return Promise.resolve();
  }

  listSuspensionRecords(
    query: SuspensionQuery = {}
  ): Promise<Page<SuspensionRecord>> {
    return Promise.resolve(
      pageRecords(
        [...this.state.suspensions.values()].filter((record) =>
          matchesSuspensionQuery(record, query)
        ),
        query,
        50,
        (record) => record.timestamps.createdAt
      )
    );
  }

  deleteSuspensionRecord(id: string): Promise<void> {
    this.state.suspensions.delete(id);
    return Promise.resolve();
  }

  getQueue(id: string): Promise<QueueRecord | null> {
    return Promise.resolve(cloneOptional(this.state.queues.get(id)));
  }

  ensureQueueRecord(record: QueueRecord): Promise<QueueRecord> {
    return this.state.lock(`queue:${record.id}`, () => {
      const existing = this.state.queues.get(record.id);
      if (existing) {
        return clone(existing);
      }
      this.state.queues.set(record.id, clone(record));
      return clone(record);
    });
  }

  putQueue(record: QueueRecord): Promise<void> {
    this.state.queues.set(record.id, clone(record));
    return Promise.resolve();
  }

  listQueueRecords(): Promise<QueueRecord[]> {
    return Promise.resolve([...this.state.queues.values()].map(clone));
  }

  commitJobRunClaim(input: JobRunClaimCommit): Promise<JobRunClaimOutcome> {
    return this.state.lock(`job:${input.expectedJob.id}`, () => {
      const currentJob = this.state.jobs.get(input.expectedJob.id);
      const currentRuns = [...this.state.runs.values()].filter(
        (run) => run.links?.jobId === input.expectedJob.id
      );
      if (
        !(
          recordsEqual(currentJob, input.expectedJob) &&
          recordSetsEqual(currentRuns, input.expectedRuns)
        )
      ) {
        return { status: "conflict" };
      }
      if (input.status === "claimed") {
        if (this.state.runs.has(input.run.id)) {
          return { status: "conflict" };
        }
        this.state.jobs.set(input.nextJob.id, clone(input.nextJob));
        this.state.runs.set(input.run.id, clone(input.run));
        return {
          claim: { job: clone(input.nextJob), run: clone(input.run) },
          status: "claimed",
        };
      }
      this.state.jobs.set(input.nextJob.id, clone(input.nextJob));
      return { job: clone(input.nextJob), status: "settled" };
    });
  }

  commitJobCancellation(
    input: JobCancellationCommit
  ): Promise<RepositoryCommitOutcome> {
    return this.state.lock(`job:${input.previousJob.id}`, () => {
      if (
        !(
          recordsEqual(
            this.state.jobs.get(input.previousJob.id),
            input.previousJob
          ) &&
          recordSetsEqual(
            [...this.state.runs.values()].filter(
              (run) => run.links?.jobId === input.previousJob.id
            ),
            input.expectedRuns
          ) &&
          recordsEqual(
            input.previousRun
              ? this.state.runs.get(input.previousRun.id)
              : undefined,
            input.previousRun
          ) &&
          recordSetsEqual(
            currentSuspensions(this.state, input.previousRun?.id).filter(
              (record) => record.status === "pending"
            ),
            input.previousSuspensions
          )
        )
      ) {
        return { status: "conflict" };
      }
      this.state.jobs.set(input.nextJob.id, clone(input.nextJob));
      if (input.nextRun) {
        this.state.runs.set(input.nextRun.id, clone(input.nextRun));
      }
      for (const suspension of input.nextSuspensions) {
        this.state.suspensions.set(suspension.id, clone(suspension));
      }
      return { status: "committed" };
    });
  }

  commitSuspensionParking(
    input: SuspensionParkingCommit
  ): Promise<RepositoryCommitOutcome> {
    return this.state.lock(`run:${input.previousRun.id}`, () => {
      if (
        !(
          recordsEqual(
            this.state.runs.get(input.previousRun.id),
            input.previousRun
          ) &&
          recordSetsEqual(
            currentSuspensions(this.state, input.previousRun.id),
            input.expectedSuspensions
          )
        ) ||
        this.state.suspensions.has(input.suspension.id)
      ) {
        return { status: "conflict" };
      }
      this.state.runs.set(input.nextRun.id, clone(input.nextRun));
      this.state.suspensions.set(input.suspension.id, clone(input.suspension));
      return { status: "committed" };
    });
  }

  commitSuspensionSettlement(
    input: SuspensionSettlementCommit
  ): Promise<RepositoryCommitOutcome> {
    return this.state.lock(`run:${input.previousRun.id}`, () => {
      if (
        !(
          recordsEqual(
            this.state.runs.get(input.previousRun.id),
            input.previousRun
          ) &&
          recordsEqual(
            this.state.suspensions.get(input.previousSuspension.id),
            input.previousSuspension
          )
        )
      ) {
        return { status: "conflict" };
      }
      this.state.runs.set(input.nextRun.id, clone(input.nextRun));
      this.state.suspensions.set(
        input.nextSuspension.id,
        clone(input.nextSuspension)
      );
      return { status: "committed" };
    });
  }

  commitSuspensionCancellation(
    input: SuspensionCancellationCommit
  ): Promise<RepositoryCommitOutcome> {
    return this.state.lock(`run:${input.previousRun.id}`, () => {
      if (
        !(
          recordsEqual(
            this.state.runs.get(input.previousRun.id),
            input.previousRun
          ) &&
          recordSetsEqual(
            currentSuspensions(this.state, input.previousRun.id).filter(
              (record) => record.status === "pending"
            ),
            input.previousSuspensions
          )
        )
      ) {
        return { status: "conflict" };
      }
      this.state.runs.set(input.nextRun.id, clone(input.nextRun));
      for (const suspension of input.nextSuspensions) {
        this.state.suspensions.set(suspension.id, clone(suspension));
      }
      return { status: "committed" };
    });
  }
}

export class InMemoryRunJournal implements RunJournal {
  constructor(private readonly state: InMemoryExecutionState) {}

  appendRunFrame(input: AppendRunFrameInput): Promise<RunFrame> {
    return this.state.lock(`frame:${input.runId}`, () => {
      if (!this.state.runs.has(input.runId)) {
        throw new RunNotFoundError(input.runId);
      }
      const frames = decodeRunFrameSequence(
        input.runId,
        this.state.frames.get(input.runId) ?? []
      );
      if (isTerminalPayload(input.payload)) {
        const terminal = frames.find((frame) =>
          isTerminalPayload(frame.payload)
        );
        if (terminal) {
          return clone(terminal);
        }
      }
      const lastFrame = frames.at(-1);
      const frame = decodeRunFrame({
        at: input.at ?? Date.now(),
        cursor: lastFrame === undefined ? 0 : lastFrame.cursor + 1,
        payload: input.payload,
        runId: input.runId,
      });
      const nextFrames = decodeRunFrameSequence(input.runId, [
        ...frames,
        frame,
      ]);
      this.state.frames.set(input.runId, nextFrames.map(clone));
      return clone(frame);
    });
  }

  claimRunEffect(input: ClaimRunEffectInput): Promise<RunFrame | null> {
    const payload = runEffectClaimPayload(input);
    return this.state.lock(`frame:${input.runId}`, () => {
      if (!this.state.runs.has(input.runId)) {
        throw new RunNotFoundError(input.runId);
      }
      const frames = decodeRunFrameSequence(
        input.runId,
        this.state.frames.get(input.runId) ?? []
      );
      if (frames.some((frame) => isRunEffectClaim(frame, input.key))) {
        return null;
      }
      const frame = decodeRunFrame({
        at: input.at ?? Date.now(),
        cursor: frames.length,
        payload,
        runId: input.runId,
      });
      const nextFrames = decodeRunFrameSequence(input.runId, [
        ...frames,
        frame,
      ]);
      this.state.frames.set(input.runId, nextFrames.map(clone));
      return clone(frame);
    });
  }

  listRunFrames(runId: string, after = -1): Promise<RunFrame[]> {
    return Promise.resolve().then(() => {
      if (!this.state.runs.has(runId)) {
        throw new RunNotFoundError(runId);
      }
      return decodeRunFrameSequence(runId, this.state.frames.get(runId) ?? [])
        .filter((frame) => frame.cursor > after)
        .map(clone);
    });
  }

  listFrames(query: RunFramePageQuery = {}): Promise<Page<RunFrame>> {
    return Promise.resolve().then(() => {
      const frames = [...this.state.frames.values()]
        .flat()
        .filter(
          (frame) =>
            (query.runId === undefined || frame.runId === query.runId) &&
            (query.after === undefined || frame.cursor > query.after)
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
      return pageRecords(frames, query, 100, (frame) => frame.at);
    });
  }

  countFrames(
    query: Pick<RunFramePageQuery, "runId" | "after"> = {}
  ): Promise<number> {
    return Promise.resolve(
      [...this.state.frames.values()]
        .flat()
        .filter(
          (frame) =>
            (query.runId === undefined || frame.runId === query.runId) &&
            (query.after === undefined || frame.cursor > query.after)
        ).length
    );
  }

  listFrameRuns(
    query: { limit?: number; offset?: number; order?: "newest" | "oldest" } = {}
  ): Promise<Page<FrameRun>> {
    const values = [...this.state.frames.entries()].flatMap(
      ([runId, frames]) => {
        const last = frames.at(-1);
        return last === undefined ? [] : [{ lastAt: last.at, runId }];
      }
    );
    return Promise.resolve(
      pageRecords(
        values,
        { order: "newest", ...query },
        3,
        (value) => value.lastAt
      )
    );
  }

  countFrameRuns(): Promise<number> {
    return Promise.resolve(
      [...this.state.frames.values()].filter((frames) => frames.length > 0)
        .length
    );
  }

  deleteRunFrames(runId: string): Promise<void> {
    this.state.frames.delete(runId);
    return Promise.resolve();
  }
}

export function createInMemoryPersistenceAdapters(
  options: { readonly snapshot?: unknown } = {}
): InMemoryExecutionPersistence {
  const state = new InMemoryExecutionState(options.snapshot);
  return {
    journal: serializeOperations(new InMemoryRunJournal(state), state),
    repository: serializeOperations(
      new InMemoryExecutionRepository(state),
      state
    ),
    snapshot: () => state.snapshot(),
    transaction: (operation) =>
      state.lock("transaction", async () => {
        const before = state.snapshot();
        const draft = new InMemoryExecutionState(before);
        const result = await operation({
          journal: new InMemoryRunJournal(draft),
          repository: new InMemoryExecutionRepository(draft),
        });
        for (const key of [
          "jobs",
          "runs",
          "suspensions",
          "queues",
          "frames",
        ] as const) {
          state[key].clear();
        }
        for (const [id, record] of draft.jobs) {
          state.jobs.set(id, record);
        }
        for (const [id, record] of draft.runs) {
          state.runs.set(id, record);
        }
        for (const [id, record] of draft.suspensions) {
          state.suspensions.set(id, record);
        }
        for (const [id, record] of draft.queues) {
          state.queues.set(id, record);
        }
        for (const [id, record] of draft.frames) {
          state.frames.set(id, record);
        }
        return result;
      }),
  };
}

function serializeOperations<T extends object>(
  operations: T,
  state: InMemoryExecutionState
): T {
  return new Proxy(operations, {
    get(target, property) {
      const operation: unknown = Reflect.get(target, property);
      if (typeof operation !== "function") {
        return operation;
      }
      return (...args: unknown[]) =>
        state.lock(
          "transaction",
          () => Reflect.apply(operation, target, args) as Promise<unknown>
        );
    },
  });
}

/** Test-only fixture support for proving post-hydration frame validation. */
export function createInMemoryPersistenceContractHarness(
  options: { readonly snapshot?: unknown } = {}
): {
  persistence: {
    repository: ExecutionRepository;
    journal: RunJournal;
  };
  replaceRunFrames(runId: string, values: readonly unknown[]): Promise<void>;
} {
  const state = new InMemoryExecutionState(options.snapshot);
  return {
    persistence: {
      journal: new InMemoryRunJournal(state),
      repository: new InMemoryExecutionRepository(state),
    },
    replaceRunFrames: (runId, values) => {
      state.frames.set(runId, values as RunFrame[]);
      return Promise.resolve();
    },
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOptional<T>(value: T | undefined): T | null {
  return value === undefined ? null : clone(value);
}

function pageRecords<T extends object>(
  records: readonly T[],
  query: {
    readonly limit?: number;
    readonly offset?: number;
    readonly order?: "newest" | "oldest";
  },
  fallback: number,
  createdAt: (record: T) => number
): Page<T> {
  const limit = query.limit ?? fallback;
  const offset = query.offset ?? 0;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 200) {
    throw new Error("[execution] page limit must be an integer from 1 to 200");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("[execution] page offset must be a non-negative integer");
  }
  const direction = query.order === "newest" ? -1 : 1;
  const ordered = [...records].sort((left, right) => {
    const byCreatedAt = createdAt(left) - createdAt(right);
    const leftId = "id" in left && typeof left.id === "string" ? left.id : "";
    const rightId =
      "id" in right && typeof right.id === "string" ? right.id : "";
    return direction * (byCreatedAt || leftId.localeCompare(rightId));
  });
  const items = ordered.slice(offset, offset + limit).map(clone);
  const hasMore = ordered.length > offset + items.length;
  return {
    hasMore,
    items,
    limit,
    nextOffset: hasMore ? offset + items.length : null,
    offset,
  };
}

function matchesStatus<T extends string>(
  status: T,
  query: T | readonly T[] | undefined
): boolean {
  return query === undefined
    ? true
    : typeof query === "string"
      ? status === query
      : query.includes(status);
}

function matchesLinks<T extends object>(
  links: T | undefined,
  query: Partial<T> | undefined
): boolean {
  return query === undefined
    ? true
    : Object.entries(query).every(
        ([key, value]) =>
          (links as Record<string, unknown> | undefined)?.[key] === value
      );
}

function matchesJobQuery(record: JobRecord, query: JobQuery): boolean {
  return (
    matchesStatus(record.status, query.status) &&
    (query.definition === undefined ||
      record.definition.name === query.definition) &&
    matchesLinks(record.links, query.links)
  );
}

function matchesRunQuery(record: RunRecord, query: RunQuery): boolean {
  const search = query.search?.trim().toLocaleLowerCase();
  return (
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
    (query.queueId === undefined || record.queueId === query.queueId) &&
    matchesStatus(record.status, query.status) &&
    (query.definition === undefined ||
      record.definition?.name === query.definition) &&
    matchesLinks(record.links, query.links) &&
    Object.entries(query.tags ?? {}).every(
      ([key, value]) => record.tags[key] === value
    )
  );
}

function matchesSuspensionQuery(
  record: SuspensionRecord,
  query: SuspensionQuery
): boolean {
  return (
    (query.runId === undefined || record.runId === query.runId) &&
    matchesStatus(record.status, query.status) &&
    (query.kind === undefined || record.kind === query.kind) &&
    (query.name === undefined || record.name === query.name) &&
    (query.occurrence === undefined ||
      record.occurrence === query.occurrence) &&
    (query.stepPath === undefined ||
      (record.stepPath.length === query.stepPath.length &&
        record.stepPath.every(
          (segment, index) => segment === query.stepPath?.[index]
        )))
  );
}

function recordsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function recordSetsEqual<T extends { readonly id: string }>(
  left: readonly T[],
  right: readonly T[]
): boolean {
  const order = (records: readonly T[]) =>
    [...records].sort((a, b) => a.id.localeCompare(b.id));
  return recordsEqual(order(left), order(right));
}

function currentSuspensions(
  state: InMemoryExecutionState,
  runId: string | undefined
): SuspensionRecord[] {
  if (!runId) {
    return [];
  }
  return [...state.suspensions.values()].filter(
    (record) => record.runId === runId
  );
}

function isTerminalPayload(payload: RunFrame["payload"]): boolean {
  if (payload.kind !== "lifecycle") {
    return false;
  }
  const value = payload.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const event = (value as Readonly<Record<string, unknown>>).event;
  return event === "complete" || event === "failed" || event === "cancelled";
}
