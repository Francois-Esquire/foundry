import type { Artifact } from "@foundry/artifacts";
import type { ContainerRow } from "@foundry/sandbox";
import type { TaskChange, TaskChangeResult, TaskNode } from "@foundry/tasks";
import type { DefinitionEntry } from "~/lib/registry";
import type { ResourceKind } from "~/lib/resources";
import type { RunStep } from "~/lib/run-trace";
import type { RunRecord } from "~/lib/workflow-runs";
import type { McpServerOptions } from "~/mcp/resources";
import type {
  DispatchInfo,
  DispatchOptions,
  EnqueueOptions,
  RunInfo,
  WorkspaceConnection,
  WorkspaceSummary,
} from "~/model/connection";
import type {
  TaskCommand,
  TaskCommandKind,
  TaskCommandResult,
} from "~/model/tasks";
import type {
  ArtifactFileSummary,
  MarblesStorage,
  ResourceScope,
} from "~/storage/ports";

export interface ExecutionBackend {
  hosted<T>(
    workspaceId: string,
    work: (workspace: WorkspaceConnection) => Promise<T>
  ): Promise<T>;
  tasks?<K extends TaskCommandKind>(
    workspaceId: string,
    command: TaskCommand<K>
  ): Promise<TaskCommandResult<K>>;
  workspaces(): Promise<readonly WorkspaceSummary[]>;
}

export interface MarblesServiceOptions {
  readonly defaultWorkspace?: string;
  readonly execution?: ExecutionBackend;
  readonly storage: MarblesStorage;
}

export interface ResourceOwnership {
  readonly id: string;
  readonly owner: string;
  readonly sharedWith: readonly string[];
}

export interface ArtifactResourceItem extends ResourceOwnership {
  readonly files?: readonly ArtifactFileSummary[];
  readonly name: string;
  readonly status: Artifact["status"];
  readonly type: Artifact["type"];
  readonly updatedAt: string;
}

export interface RunResourceItem extends ResourceOwnership {
  readonly createdAt: string;
  readonly status: RunRecord["status"];
  readonly step: RunRecord["step"];
  readonly steps: readonly RunStep[];
}

export interface SandboxResourceItem extends ResourceOwnership {
  readonly createdAt: string;
  readonly status: ContainerRow["status"];
}

export interface SessionResourceItem extends ResourceOwnership {
  readonly messages: number;
  readonly summarized: boolean;
  readonly updatedAt: string;
}

export type ResourceItem =
  | ArtifactResourceItem
  | RunResourceItem
  | SandboxResourceItem
  | SessionResourceItem;

interface WorkspacesService {
  definitions(workspaceId: string): Promise<readonly DefinitionEntry[]>;
  get(id: string): Promise<WorkspaceSummary | undefined>;
  list(): Promise<readonly WorkspaceSummary[]>;
}

interface TasksService {
  change(workspaceId: string, change: TaskChange): Promise<TaskChangeResult>;
  get(
    workspaceId: string,
    id: string,
    depth?: number
  ): Promise<TaskNode | undefined>;
  list(
    workspaceId: string,
    query?: TaskCommand<"list">["query"]
  ): Promise<TaskCommandResult<"list">>;
  run<K extends TaskCommandKind>(
    workspaceId: string,
    command: TaskCommand<K>
  ): Promise<TaskCommandResult<K>>;
}

interface RunsService {
  cancel(workspaceId: string, runId: string): Promise<RunInfo>;
  enqueue(
    workspaceId: string,
    name: string,
    input: unknown,
    options?: EnqueueOptions
  ): Promise<DispatchInfo>;
  get(scope: ResourceScope, id: string): Promise<RunResourceItem | undefined>;
  list(
    scope: ResourceScope,
    limit?: number
  ): Promise<readonly RunResourceItem[]>;
}

export interface ResourceReader<T extends ResourceItem> {
  get(scope: ResourceScope, id: string): Promise<T | undefined>;
  list(scope: ResourceScope): Promise<readonly T[]>;
}

interface AgentsService {
  dispatch(
    workspaceId: string,
    options: DispatchOptions
  ): Promise<DispatchInfo>;
}

interface ResourcesService {
  get(
    kind: ResourceKind,
    scope: ResourceScope,
    id: string
  ): Promise<ResourceItem | undefined>;
  list(
    kind: ResourceKind,
    scope: ResourceScope
  ): Promise<readonly ResourceItem[]>;
}

export interface MarblesService {
  readonly agents: AgentsService;
  readonly artifacts: ResourceReader<ArtifactResourceItem>;
  readonly resources: ResourcesService;
  readonly runs: RunsService;
  readonly sandboxes: ResourceReader<SandboxResourceItem>;
  readonly sessions: ResourceReader<SessionResourceItem>;
  readonly tasks: TasksService;
  toMcpOptions(defaultWorkspace?: string): McpServerOptions;
  readonly workspaces: WorkspacesService;
}
