import type {
  JobRecord,
  JobStatus,
  QueueRecord,
  RunFrame,
  RunRecord,
  RunStatus,
  SuspensionRecord,
  SuspensionStatus,
} from "../schema";

/**
 * One atomic write. Deletes apply before puts. A key is left out, never set
 * to `undefined`.
 *
 * A put files a record under its key, or replaces the record filed there:
 * an id for a Queue, Job, Run or Suspension, and a Run id with a cursor for
 * a frame. A replaced record keeps its place in list order; a new one goes
 * last.
 */
export interface WorkflowStoreWrite {
  readonly deleteJobs?: readonly string[];
  /** Run ids: every frame of each Run goes. The Runs themselves stay. */
  readonly deleteRunFrames?: readonly string[];
  readonly deleteRuns?: readonly string[];
  readonly deleteSuspensions?: readonly string[];
  readonly putFrames?: readonly RunFrame[];
  readonly putJobs?: readonly JobRecord[];
  readonly putQueues?: readonly QueueRecord[];
  readonly putRuns?: readonly RunRecord[];
  readonly putSuspensions?: readonly SuspensionRecord[];
}

/**
 * Where a list read stops and the next page starts. Opaque: pass back the
 * `next` a page returned, and nothing else.
 */
export type WorkflowStoreCursor = number;

/** Which page of a list read to return. */
export interface WorkflowStorePageQuery {
  /** Only records after this cursor; from the first record when absent. */
  readonly after?: WorkflowStoreCursor;
  /** At most this many records: a positive safe integer. */
  readonly limit: number;
}

/** One page of a list read, in the order the records were first put. */
export interface WorkflowStorePage<T> {
  readonly items: readonly T[];
  /** Present when a further record matches; pass it as `after` to read on. */
  readonly next?: WorkflowStoreCursor;
}

export interface JobListQuery extends WorkflowStorePageQuery {
  /** Only Jobs in one of these statuses; every Job when absent. */
  readonly status?: readonly JobStatus[];
}

export interface RunListQuery extends WorkflowStorePageQuery {
  readonly queueId?: string;
  /** Only Runs in one of these statuses; every Run when absent. */
  readonly status?: readonly RunStatus[];
}

export interface SuspensionListQuery extends WorkflowStorePageQuery {
  readonly runId?: string;
  /** Only Suspensions in one of these statuses; every one when absent. */
  readonly status?: readonly SuspensionStatus[];
}

export interface FrameListQuery extends WorkflowStorePageQuery {
  /** Only this Run's frames; every frame when absent. */
  readonly runId?: string;
}

/**
 * The persistence seam. A store keeps Queues, Jobs, Runs, Suspensions and
 * the Run journal's frames, and applies one write atomically. It enforces
 * nothing: unique ids, lifecycle transitions, the frame sequence of a Run,
 * first-writer Queues and effect claims are the rules of
 * `ExecutionCoordinator` (`@foundry/workflows`), checked before a write
 * reaches the store. Values crossing this seam are detached: a store takes
 * its own copy of a write when `commit` is called, and a caller changing
 * the write afterwards changes nothing it keeps.
 *
 * List reads return records in the order they were first put, filtered by
 * exact column values and paged by cursor. Searching, sorting by creation
 * time and matching tags or links stay with the coordinator.
 *
 * `@foundry/workflows/store/memory` and `@foundry/workflows/store/sqlite`
 * implement it; `@foundry/workflows/testing/store` is the suite every
 * implementation passes.
 */
export interface WorkflowStore {
  commit(write: WorkflowStoreWrite): Promise<void>;
  getJob(id: string): Promise<JobRecord | null>;
  getQueue(id: string): Promise<QueueRecord | null>;
  getRun(id: string): Promise<RunRecord | null>;
  getSuspension(id: string): Promise<SuspensionRecord | null>;
  listFrames(query: FrameListQuery): Promise<WorkflowStorePage<RunFrame>>;
  listJobs(query: JobListQuery): Promise<WorkflowStorePage<JobRecord>>;
  /** Every Queue: a host keeps a handful. */
  listQueues(): Promise<readonly QueueRecord[]>;
  listRuns(query: RunListQuery): Promise<WorkflowStorePage<RunRecord>>;
  listSuspensions(
    query: SuspensionListQuery
  ): Promise<WorkflowStorePage<SuspensionRecord>>;
  /**
   * Runs one read-modify-write, or one read of several steps, so that no
   * other write lands between its reads and its commit, from any
   * coordinator over the store: a plain `commit` waits until `work`
   * settles. `work` reads and commits through `view` only, and its reads
   * see its own commits: a call to the store itself from inside `work`
   * rejects at once with an error saying to use the view. If `work` throws,
   * none of its commits stay. Without it, changes are serialized per
   * coordinator and no further.
   */
  transaction?<T>(work: (view: WorkflowStore) => Promise<T>): Promise<T>;
}
