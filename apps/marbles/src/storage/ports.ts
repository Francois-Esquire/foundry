import type { SessionRecord } from "@foundry/agents/session";
import type { SessionStore } from "@foundry/agents/store";
import type {
  Artifact,
  ArtifactSubstrate,
  BlobFiles,
} from "@foundry/artifacts";
import type { ProcessIdentity } from "@foundry/lib/process-identity";
import type { QueueStoreService } from "@foundry/queue/store";
import type { ContainerRow } from "@foundry/sandbox";
import type { ContainerStore } from "@foundry/sandbox/store";
import type { ScheduleStoreService } from "@foundry/scheduling/store";
import type { TaskStore } from "@foundry/tasks/store";
import type { WorkspaceStore } from "@foundry/workspaces/store";
import type { ResourceKind, ResourceRef } from "~/lib/resources";
import type { OutputRecord } from "~/lib/state/output";
import type { RunRecord } from "~/lib/workflow-runs";

export type BlobStorage = BlobFiles;
export type ResourceScope =
  | { readonly workspace: string }
  | { readonly all: true };
export interface StoredWorkspace {
  readonly config: string | null;
  readonly cwd: string;
  readonly firstSeen: string;
  readonly hosted: boolean;
  readonly id: string;
  readonly lastSeen: string;
  readonly root: string;
}
export interface TouchWorkspaceInput {
  readonly id: string;
  readonly root: string;
}
export interface TouchWorkspaceOptions {
  readonly cwd?: string;
  readonly hosted?: boolean;
}
export interface ShownResource<T> {
  readonly ref: ResourceRef;
  readonly value: T;
  readonly workspaces: readonly string[];
}
export interface StoredRunEntry {
  readonly owner: ProcessIdentity | null;
  readonly record: RunRecord;
}
export interface SessionMessageTally {
  readonly messages: number;
  readonly summarized: boolean;
}
export interface ArtifactFileSummary {
  readonly blob: string | null;
  readonly path: string;
}
export interface RunStreamStorage {
  append(runId: string, record: OutputRecord): void;
  read(runId: string): readonly OutputRecord[];
  remove(runId: string): void;
}
export interface WorkspaceRegistryPort {
  get(id: string): Promise<StoredWorkspace | undefined>;
  list(): Promise<readonly StoredWorkspace[]>;
  touch(
    workspace: TouchWorkspaceInput,
    config: string | null,
    options?: TouchWorkspaceOptions
  ): Promise<void>;
  unhost(id: string): Promise<boolean>;
}
export interface WorkspaceStoresPort {
  readonly artifacts: ArtifactSubstrate;
  readonly containers: ContainerStore;
  readonly queue: QueueStoreService;
  readonly schedules: ScheduleStoreService;
  readonly sessions: SessionStore;
  readonly tasks: TaskStore;
  readonly workspaces: WorkspaceStore;
}
export interface MarblesStorage {
  artifactFiles(ref: ResourceRef): Promise<readonly ArtifactFileSummary[]>;
  artifacts(scope: ResourceScope): Promise<readonly ShownResource<Artifact>[]>;
  readonly blobs?: BlobStorage;
  close?(): Promise<void> | void;
  find(
    scope: ResourceScope,
    kind: ResourceKind,
    id: string
  ): Promise<readonly ResourceRef[]>;
  forWorkspace(workspaceId: string): Promise<WorkspaceStoresPort>;
  messageTallies(
    refs: readonly ResourceRef[]
  ): Promise<ReadonlyMap<string, SessionMessageTally>>;
  readonly output: RunStreamStorage;
  runs(
    scope: ResourceScope,
    limit?: number
  ): Promise<readonly ShownResource<StoredRunEntry>[]>;
  sandboxes(
    scope: ResourceScope
  ): Promise<readonly ShownResource<ContainerRow>[]>;
  sessions(
    scope: ResourceScope
  ): Promise<readonly ShownResource<SessionRecord>[]>;
  share(ref: ResourceRef, targetWorkspaceId: string): Promise<void>;
  unshare(ref: ResourceRef, targetWorkspaceId: string): Promise<void>;
  readonly workspaces: WorkspaceRegistryPort;
}
export function resourceRefKey(ref: ResourceRef): string {
  return `${ref.kind}:${ref.owner}:${ref.id}`;
}
