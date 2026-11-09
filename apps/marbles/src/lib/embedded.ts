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

export type { SessionEvent, SessionStore } from "@foundry/agents/session";
// biome-ignore lint/performance/noBarrelFile: This is the public package entry point for embedded hosts.
export { InMemorySessionStore } from "@foundry/agents/session";
export type { Artifacts } from "@foundry/artifacts";
export { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";
export { blobFiles, JsonArtifactStore } from "@foundry/artifacts/node";
export type { ModelManagerCredentials, Provider } from "@foundry/models";
export { ModelManager } from "@foundry/models";
export { gatewayBinding } from "@foundry/models/gateway";
export { vercelBinding } from "@foundry/models/vercel";
export type { Containers } from "@foundry/sandbox/container/containers";

export type { EngineOptions } from "./engine";
export { Engine, RunEndedError } from "./engine";
export type { ExecutionStatus } from "./execution-statuses";
export {
  EXECUTION_STATUSES,
  SETTLED_EXECUTION_STATUSES,
} from "./execution-statuses";
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
export type { JsonSessionStoreOptions } from "./sessions/json-store";
export { JsonSessionStore } from "./sessions/json-store";
export type {
  StateCollection,
  StateStore,
  StoredDocument,
} from "./state/store";
export { InMemoryStateStore, JsonStateStore } from "./state/store";
export type { TaskContext, TaskDefinition, TaskObservation } from "./tasks";
export type {
  AgentDefinition,
  Agents,
  SandboxAgentOptions,
  SandboxHandle,
  Session,
  SessionRef,
} from "./types";
