import type {
  JobRecord,
  JobStatus,
  QueueRecord,
  RunEvent,
  RunFrame,
  RunRecord,
  RunStatus,
  SuspensionRecord,
  SuspensionStatus,
} from "../schema";

export interface WorkflowStoreWrite {
  readonly deleteJobs?: readonly string[];
  readonly deleteRunFrames?: readonly string[];
  readonly deleteRuns?: readonly string[];
  readonly deleteSuspensions?: readonly string[];
  readonly events?: readonly RunEvent[];
  readonly putFrames?: readonly RunFrame[];
  readonly putJobs?: readonly JobRecord[];
  readonly putQueues?: readonly QueueRecord[];
  readonly putRuns?: readonly RunRecord[];
  readonly putSuspensions?: readonly SuspensionRecord[];
}

export type WorkflowStoreDurability = "commit" | "host";

export type WorkflowStoreCursor = number;

export interface WorkflowStorePageQuery {
  readonly after?: WorkflowStoreCursor;
  readonly limit: number;
}

export interface WorkflowStorePage<T> {
  readonly items: readonly T[];
  readonly next?: WorkflowStoreCursor;
}

export interface JobListQuery extends WorkflowStorePageQuery {
  readonly status?: readonly JobStatus[];
}

export interface RunListQuery extends WorkflowStorePageQuery {
  readonly queueId?: string;
  readonly status?: readonly RunStatus[];
}

export interface SuspensionListQuery extends WorkflowStorePageQuery {
  readonly runId?: string;
  readonly status?: readonly SuspensionStatus[];
}

export interface FrameListQuery extends WorkflowStorePageQuery {
  readonly runId?: string;
}

export interface WorkflowStore {
  commit(write: WorkflowStoreWrite): Promise<void>;
  readonly durability?: WorkflowStoreDurability;
  getJob(id: string): Promise<JobRecord | null>;
  getQueue(id: string): Promise<QueueRecord | null>;
  getRun(id: string): Promise<RunRecord | null>;
  getSuspension(id: string): Promise<SuspensionRecord | null>;
  listFrames(query: FrameListQuery): Promise<WorkflowStorePage<RunFrame>>;
  listJobs(query: JobListQuery): Promise<WorkflowStorePage<JobRecord>>;
  listQueues(): Promise<readonly QueueRecord[]>;
  listRuns(query: RunListQuery): Promise<WorkflowStorePage<RunRecord>>;
  listSuspensions(
    query: SuspensionListQuery
  ): Promise<WorkflowStorePage<SuspensionRecord>>;
  transaction?<T>(work: (view: WorkflowStore) => Promise<T>): Promise<T>;
}
