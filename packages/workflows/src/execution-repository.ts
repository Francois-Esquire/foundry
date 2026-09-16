import type { SuspensionState } from "./channels";
import type {
  DefinitionReference,
  JobLinks,
  JobRecord,
  JobStatus,
  JsonValue,
  RunLinks,
  RunRecord,
  RunTimestamps,
  SuspensionRecord,
  SuspensionStatus,
} from "./execution-records";
import type { Extensions } from "./extensions";
import type { WorkflowSnapshot } from "./snapshot";
import type { ErrorShape, QueueStatus, RunStatus } from "./types";

export interface Page<T> {
  hasMore: boolean;
  items: T[];
  limit: number;
  nextOffset: number | null;
  offset: number;
}

/** A paginated Run slice plus the matching count before pagination. */
export interface RunPage extends Page<RunRecord> {
  total: number;
}

export interface PageQuery {
  limit?: number;
  offset?: number;
  order?: "newest" | "oldest";
}

export interface CreateRunInput {
  definition?: DefinitionReference;
  extensions?: Extensions;
  id?: string;
  input: unknown;
  links?: DirectRunLinks;
  metadata?: Record<string, unknown>;
  queueId: string;
  snapshot?: WorkflowSnapshot;
  step: string;
  tags?: Record<string, string>;
}

/** Correlation accepted for Runs that are not managed by a Job. */
export type DirectRunLinks = Omit<RunLinks, "jobId"> & {
  readonly jobId?: never;
};

export type CreateJobRunInput = Omit<CreateRunInput, "links"> & {
  links?: Omit<RunLinks, "jobId">;
};

export interface JobRunClaim {
  readonly job: JobRecord;
  readonly run: RunRecord;
}

/**
 * The committed result of coordinating one managed Job attempt.
 *
 * `settled` is a successful persistence outcome. The execution coordinator
 * translates it to the legacy `JobAlreadySettledError` only after the
 * repository transaction has committed.
 */
export type JobRunClaimOutcome =
  | { readonly status: "claimed"; readonly claim: JobRunClaim }
  | { readonly status: "settled"; readonly job: JobRecord }
  | { readonly status: "conflict" };

export interface JobCancellation {
  readonly job: JobRecord;
  readonly run: RunRecord | null;
  readonly suspensions: readonly SuspensionRecord[];
}

/** Transaction-bound operations for cancelling a Job execution aggregate. */
export interface JobCancellationTransaction {
  readJob(): Promise<JobRecord | null>;
  readRuns(): Promise<RunRecord[]>;
  readSuspensions(): Promise<SuspensionRecord[]>;
  write(input: {
    previousJob: JobRecord;
    nextJob: JobRecord;
    previousRun: RunRecord | null;
    nextRun: RunRecord | null;
    previousSuspensions: readonly SuspensionRecord[];
    nextSuspensions: readonly SuspensionRecord[];
  }): Promise<void>;
}

/** Transaction-bound operations used by an atomic managed-attempt claim. */
export interface JobRunClaimTransaction {
  readJob(): Promise<JobRecord | null>;
  readRun(id: string): Promise<RunRecord | null>;
  readRuns(): Promise<RunRecord[]>;
  write(input: {
    previousJob: JobRecord;
    nextJob: JobRecord;
    run: RunRecord;
  }): Promise<void>;
  writeJob(record: JobRecord): Promise<void>;
}

export interface UpdateRunInput {
  error?: ErrorShape;
  extensions?: Extensions;
  metadata?: Record<string, unknown>;
  output?: unknown;
  snapshot?: WorkflowSnapshot;
  status?: RunStatus;
  tags?: Record<string, string>;
  timestamps?: Partial<RunTimestamps>;
}

export interface RunQuery extends PageQuery {
  definition?: string;
  links?: Partial<RunLinks>;
  queueId?: string;
  search?: string;
  status?: RunStatus | RunStatus[];
  tags?: Record<string, string>;
}

export interface CreateJobInput {
  definition: DefinitionReference;
  id?: string;
  input: JsonValue;
  links?: JobLinks;
}

export interface UpdateJobInput {
  status?: JobStatus;
  timestamps?: Partial<JobRecord["timestamps"]>;
}

export interface JobQuery extends PageQuery {
  definition?: string;
  links?: Partial<JobLinks>;
  status?: JobStatus | JobStatus[];
}

export interface CreateSuspensionInput {
  id?: string;
  kind: string;
  name: string;
  occurrence?: number;
  reason: string;
  request: JsonValue;
  runId: string;
  stepPath: readonly string[];
}

export interface SuspensionQuery extends PageQuery {
  kind?: string;
  name?: string;
  occurrence?: number;
  runId?: string;
  status?: SuspensionStatus | SuspensionStatus[];
  stepPath?: readonly string[];
}

export type SuspensionSettlementOutcome =
  | { status: "resolved"; resolution: JsonValue }
  | { status: "cancelled" };

export interface SettleSuspensionInput {
  expectedRevision: number;
  outcome: SuspensionSettlementOutcome;
  runPatch?: Omit<UpdateRunInput, "status">;
}

export interface SuspensionSettlement {
  run: RunRecord;
  suspension: SuspensionRecord;
}

export interface SuspensionParking {
  readonly created: boolean;
  readonly suspension: SuspensionRecord;
}

/** Transaction-bound operations for one stable Suspension occurrence. */
export interface SuspensionParkingTransaction {
  readRun(): Promise<RunRecord | null>;
  readSuspensions(): Promise<SuspensionRecord[]>;
  write(input: { suspension: SuspensionRecord; run: RunRecord }): Promise<void>;
}

/** Transaction-bound operations for resolving or cancelling one Suspension. */
export interface SuspensionSettlementTransaction {
  readRun(runId: string): Promise<RunRecord | null>;
  readSuspension(): Promise<SuspensionRecord | null>;
  write(input: {
    previousSuspension: SuspensionRecord;
    nextSuspension: SuspensionRecord;
    previousRun: RunRecord;
    nextRun: RunRecord;
  }): Promise<void>;
}

export interface SuspensionCancellation {
  readonly run: RunRecord;
  readonly suspensions: readonly SuspensionRecord[];
}

/** Transaction-bound operations for cancelling a Run and pending Suspensions. */
export interface SuspensionCancellationTransaction {
  readRun(): Promise<RunRecord | null>;
  readSuspensions(): Promise<SuspensionRecord[]>;
  write(input: {
    previousRun: RunRecord;
    nextRun: RunRecord;
    previousSuspensions: readonly SuspensionRecord[];
    nextSuspensions: readonly SuspensionRecord[];
  }): Promise<void>;
}

export interface EnsureQueueInput {
  extensions?: Extensions;
  id: string;
  name: string;
}

export interface UpdateQueueInput {
  extensions?: Extensions;
  lastError?: ErrorShape | null;
  status?: QueueStatus;
}

export interface QueueRecord {
  createdAt: number;
  extensions: Extensions;
  id: string;
  lastError: ErrorShape | null;
  name: string;
  status: QueueStatus;
}

export interface RecoverableRun {
  definition?: DefinitionReference;
  extensions: Extensions;
  id: string;
  input: unknown;
  lastStatus: RunStatus;
  links?: RunLinks;
  metadata?: Record<string, unknown>;
  step: string;
  suspension?: SuspensionState;
}

/** Domain-facing execution commands retained by the Store compatibility seam. */
export interface ExecutionCommands {
  cancelJob(id: string): Promise<JobCancellation>;
  cancelRun(
    runId: string,
    runPatch?: Omit<UpdateRunInput, "status">
  ): Promise<SuspensionCancellation>;
  cancelRunSuspensions(
    runId: string,
    runPatch?: Omit<UpdateRunInput, "status">
  ): Promise<SuspensionCancellation>;
  claimJobRun(jobId: string, input: CreateJobRunInput): Promise<JobRunClaim>;
  createJob(input: CreateJobInput): Promise<JobRecord>;

  createRun(input: CreateRunInput): Promise<RunRecord>;

  createSuspension(input: CreateSuspensionInput): Promise<SuspensionRecord>;
  deleteJob(id: string): Promise<void>;
  deleteRun(id: string): Promise<void>;
  deleteSuspension(id: string): Promise<void>;

  ensureQueue(input: EnsureQueueInput): Promise<QueueRecord>;
  findRecoverableRuns(queueId: string): Promise<RecoverableRun[]>;
  getJob(id: string): Promise<JobRecord | null>;
  getRun(id: string): Promise<RunRecord | null>;
  getSuspension(id: string): Promise<SuspensionRecord | null>;
  listJobs(query?: JobQuery): Promise<Page<JobRecord>>;
  listQueues(): Promise<QueueRecord[]>;
  listRuns(query: RunQuery): Promise<RunPage>;
  listSuspensions(query?: SuspensionQuery): Promise<Page<SuspensionRecord>>;
  parkSuspension(
    input: CreateSuspensionInput,
    runPatch?: Omit<UpdateRunInput, "status">
  ): Promise<SuspensionParking>;
  settleSuspension(
    id: string,
    input: SettleSuspensionInput
  ): Promise<SuspensionSettlement>;
  updateJob(id: string, patch: UpdateJobInput): Promise<JobRecord | null>;
  updateQueue(id: string, patch: UpdateQueueInput): Promise<QueueRecord | null>;
  updateRun(id: string, patch: UpdateRunInput): Promise<RunRecord | null>;
}

export type RepositoryCommitOutcome =
  | { readonly status: "committed" }
  | { readonly status: "conflict" };

export type JobRunClaimCommit =
  | {
      readonly status: "claimed";
      readonly expectedJob: JobRecord;
      readonly expectedRuns: readonly RunRecord[];
      readonly nextJob: JobRecord;
      readonly run: RunRecord;
    }
  | {
      readonly status: "settled";
      readonly expectedJob: JobRecord;
      readonly expectedRuns: readonly RunRecord[];
      readonly nextJob: JobRecord;
    };

export interface JobCancellationCommit {
  readonly expectedRuns: readonly RunRecord[];
  readonly nextJob: JobRecord;
  readonly nextRun: RunRecord | null;
  readonly nextSuspensions: readonly SuspensionRecord[];
  readonly previousJob: JobRecord;
  readonly previousRun: RunRecord | null;
  readonly previousSuspensions: readonly SuspensionRecord[];
}

export interface SuspensionParkingCommit {
  readonly expectedSuspensions: readonly SuspensionRecord[];
  readonly nextRun: RunRecord;
  readonly previousRun: RunRecord;
  readonly suspension: SuspensionRecord;
}

export interface SuspensionSettlementCommit {
  readonly nextRun: RunRecord;
  readonly nextSuspension: SuspensionRecord;
  readonly previousRun: RunRecord;
  readonly previousSuspension: SuspensionRecord;
}

export interface SuspensionCancellationCommit {
  readonly nextRun: RunRecord;
  readonly nextSuspensions: readonly SuspensionRecord[];
  readonly previousRun: RunRecord;
  readonly previousSuspensions: readonly SuspensionRecord[];
}

/**
 * Durable execution records plus explicit atomic aggregate commits.
 *
 * This seam stores proposed records; lifecycle decisions remain in the
 * coordinator. No transaction callback crosses it.
 */
export interface ExecutionRepository {
  commitJobCancellation(
    input: JobCancellationCommit
  ): Promise<RepositoryCommitOutcome>;

  commitJobRunClaim(input: JobRunClaimCommit): Promise<JobRunClaimOutcome>;
  commitSuspensionCancellation(
    input: SuspensionCancellationCommit
  ): Promise<RepositoryCommitOutcome>;
  commitSuspensionParking(
    input: SuspensionParkingCommit
  ): Promise<RepositoryCommitOutcome>;
  commitSuspensionSettlement(
    input: SuspensionSettlementCommit
  ): Promise<RepositoryCommitOutcome>;
  deleteJobRecord(id: string): Promise<void>;
  deleteRunRecord(id: string): Promise<void>;
  deleteSuspensionRecord(id: string): Promise<void>;
  ensureQueueRecord(record: QueueRecord): Promise<QueueRecord>;
  getJob(id: string): Promise<JobRecord | null>;

  getQueue(id: string): Promise<QueueRecord | null>;

  getRun(id: string): Promise<RunRecord | null>;

  getSuspension(id: string): Promise<SuspensionRecord | null>;
  listJobRecords(query?: JobQuery): Promise<Page<JobRecord>>;
  listQueueRecords(): Promise<QueueRecord[]>;
  listRunRecords(query?: RunQuery): Promise<RunPage>;
  listSuspensionRecords(
    query?: SuspensionQuery
  ): Promise<Page<SuspensionRecord>>;
  putJob(record: JobRecord): Promise<void>;
  putQueue(record: QueueRecord): Promise<void>;
  putRun(record: RunRecord): Promise<void>;
  putSuspension(record: SuspensionRecord): Promise<void>;
}
