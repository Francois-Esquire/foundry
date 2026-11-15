/**
 * The embedded-host entry, `@foundry.sh/marbles/engine`: the `Engine`, its
 * Execution Runs and host tasks, and the stores an instance is built from,
 * without the CLI harness providers the lib entry also carries. A host that
 * bundles the engine (an Electron main process) loads the Claude Code and
 * Codex SDKs only if a CLI harness actually runs.
 *
 * The package classes are re-exported for the same reason as in the lib
 * entry: these are the copies an instance has to come from.
 */

export type { SessionEvent } from "@foundry/agents/session";
// biome-ignore lint/performance/noBarrelFile: This is the public package entry point for embedded hosts.
export { Sessions } from "@foundry/agents/session";
export type { SessionStore, SessionStoreWrite } from "@foundry/agents/store";
export { InMemorySessionStore } from "@foundry/agents/store/memory";
export type { Artifacts } from "@foundry/artifacts";
export { ArtifactManager } from "@foundry/artifacts";
export { blobFiles, JsonArtifactStore } from "@foundry/artifacts/node";
export { InMemoryArtifactStore } from "@foundry/artifacts/store/memory";
export type { GrantDocumentStorage } from "@foundry/lib/config/authorization/document";
export type { Provider } from "@foundry/models";
export { ModelManager } from "@foundry/models";
export { gatewayModels, gatewayProvider } from "@foundry/models/gateway";
export { vercelProvider } from "@foundry/models/vercel";
export type { Containers } from "@foundry/sandbox/container/containers";
export type { AutomationRecord } from "./automation/service";
export type {
  AutomationStore,
  AutomationView,
  StoredAutomation,
} from "./automation/store";
export { MemoryAutomationStore } from "./automation/store";
export type { EngineOptions } from "./engine";
export { Engine, RunEndedError } from "./engine";
export type {
  PendingQuery,
  StreamItem,
  WorkspaceRecords,
} from "./events/records";
export { MemoryWorkspaceRecords } from "./events/records";
export type { ExecutionStatus } from "./execution-statuses";
export {
  EXECUTION_STATUSES,
  SETTLED_EXECUTION_STATUSES,
} from "./execution-statuses";
export type {
  ExecutionStore,
  ExecutionView,
  StoredExecution,
} from "./execution-store";
export { MemoryExecutionStore } from "./execution-store";
export type {
  ExecutionObservation,
  ExecutionRun,
  ExecutionRuns,
  ExecutionSubscription,
  ExecutionUsage,
  HostObservation,
  ModelTurnObservation,
  ObservationStatus,
  QueueSettings,
  QueueState,
  RetentionGap,
  ToolCallObservation,
} from "./executions";
export { DEFAULT_QUEUE } from "./executions";
export type { Launched, LaunchOptions } from "./launcher";
export type { RecordedScope } from "./run-scope";
export type { RunStore, StoredScope } from "./run-store";
export { MemoryRunStore } from "./run-store";
export type { ActivityRecord, ActivityStore } from "./sandbox/activities";
export type {
  DeferredApprovalStore,
  SavedApprovals,
} from "./sandbox/deferred-approvals";
export { MemoryDeferredApprovalStore } from "./sandbox/deferred-approvals";
export type { TaskContext, TaskDefinition, TaskObservation } from "./tasks";
export type {
  MonitorState,
  ScheduleHistory,
  TickClaim,
  TriggerStore,
} from "./trigger-store";
export { MemoryTriggerStore } from "./trigger-store";
export type {
  AgentDefinition,
  Agents,
  SandboxAgentOptions,
  SandboxHandle,
  Session,
  SessionRef,
} from "./types";
export type { RecordedUsageFact } from "./usage";
export type { StoredUsage, UsageOwner, UsageStore } from "./usage-store";
export { MemoryUsageStore } from "./usage-store";
