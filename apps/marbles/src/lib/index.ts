/**
 * The lib entry, `@foundry.sh/marbles/lib`: everything the embedded entry
 * (`./embedded`) carries, which is the `Engine`, its Execution Runs and host
 * tasks, and the package classes an instance is built from, plus the CLI
 * harness providers and the types and constants (`CLI_HARNESS_IDS`,
 * `CLI_HARNESSES`, `TERMINAL_RUN_STATUSES`) a programmatic host reads. Build
 * the instances, hand them to the engine, tell it what can run with
 * `define`, `schedule`, `monitor` and `task`, start it, and launch by name;
 * read and follow every run through `engine.executions`; or call its
 * managers directly. The words an authoring module writes definitions with
 * live in the package's main entry; this one takes what they produce as
 * data.
 *
 * The package classes are re-exported because the package bundles them:
 * these are the copies an instance has to come from to be handed to the
 * engine.
 */

export type { TurnExecutorRef } from "@foundry/models";
// biome-ignore lint/performance/noBarrelFile: This is the public package entry point for programmatic hosts.
export { claudeCodeProvider } from "@foundry/models/claude-code";
export { codexProvider } from "@foundry/models/codex";
export { piProvider } from "@foundry/models/pi";
// `containers`: where sandboxes run.
export { createContainers } from "@foundry/sandbox/container/containers";
export { createMemoryContainerStore } from "@foundry/sandbox/container/store";
export type { ChannelMessage } from "@foundry/workflows/channels";
export type { RunRecord } from "@foundry/workflows/store";
// `workspaces`: directories and repositories.
export { WorkspaceSystem } from "@foundry/workspaces";
export { git } from "@foundry/workspaces/git";
export { directory } from "@foundry/workspaces/node";
export { nodeObserver } from "@foundry/workspaces/node/watch";
export type {
  AutomationRecord,
  AutomationService,
} from "./automation/service";
export type {
  CliHarness,
  CliHarnessDescriptor,
  GuestArchitecture,
  GuestArtifact,
  GuestAuth,
  GuestFile,
} from "./cli-harnesses";
export { CLI_HARNESS_IDS, CLI_HARNESSES } from "./cli-harnesses";
export type {
  AnyDefinition,
  LockedNode,
  NamedDefinition,
  SetupFn,
  StepFn,
  StepRecord,
  WorkflowRecord,
} from "./definition";
export * from "./embedded";
export type { FeedAnswer } from "./feed/entry";
export type {
  FeedEntrySnapshot,
  FeedMediaSnapshot,
  FeedReader,
} from "./feed/read";
export type { Log, LogLevel } from "./log";
export type { AgentsManager } from "./managers/agents";
export type { ArtifactsManager } from "./managers/artifacts";
export type { SandboxesManager } from "./managers/sandboxes";
export type { WorkspacesManager } from "./managers/workspaces";
export type {
  Change,
  FileChange,
  HttpChange,
  MonitorContext,
  MonitorHandler,
  MonitorSpec,
} from "./monitor";
export type { DefinitionEntry, MonitorRecord } from "./registry";
export type { ReadonlyRunScopes, RunScope } from "./run-scope";
export type { ActivityRecord, HarnessActivities } from "./sandbox/activities";
export type { HarnessInteractions } from "./sandbox/interactions";
export type { SandboxAuthority } from "./sandbox/session";
export type { HeldLock, Lock } from "./state/locks";
export { TERMINAL_RUN_STATUSES } from "./state/runs";
export type { CalendarSlot, Schedule, Trigger, Weekday } from "./triggers";
export type {
  AgentDefinition,
  Agents,
  ArtifactDefinition,
  Artifacts,
  Context,
  SandboxDefinition,
  Sandboxes,
  SandboxHandle,
  SandboxSpec,
  Session,
  SessionOptions,
  SessionRef,
  WorkspaceDefinition,
  WorkspaceHandle,
  Workspaces,
} from "./types";
