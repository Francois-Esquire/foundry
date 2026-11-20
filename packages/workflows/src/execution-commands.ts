import type { Page, PageInput } from "@foundry/core/pagination";
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
import type { QueueRecord } from "./schema";
import type { WorkflowSnapshot } from "./snapshot";
import type { ErrorShape, QueueStatus, RunStatus } from "./types";

export interface PageQuery extends PageInput<number> {
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

export interface JobCancellation {
  readonly job: JobRecord;
  readonly run: RunRecord | null;
  readonly suspensions: readonly SuspensionRecord[];
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

export interface SuspensionCancellation {
  readonly run: RunRecord;
  readonly suspensions: readonly SuspensionRecord[];
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
  claimSuspensions(runId: string): Promise<readonly SuspensionRecord[]>;
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
  listJobs(query?: JobQuery): Promise<Page<JobRecord, number>>;
  listQueues(): Promise<QueueRecord[]>;
  listRuns(query: RunQuery): Promise<Page<RunRecord, number>>;
  listSuspensions(
    query?: SuspensionQuery
  ): Promise<Page<SuspensionRecord, number>>;
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
