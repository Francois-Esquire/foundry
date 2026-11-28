// biome-ignore lint/performance/noBarrelFile: This is the public package entry point for programmatic hosts.
export { createContainers } from "@foundry/sandbox";
export { MemoryContainerStore } from "@foundry/sandbox/store/memory";
export type { ChannelMessage } from "@foundry/workflows/channels";
export { Workspaces } from "@foundry/workspaces";
export type {
  ContextKey,
  ContextRuntime,
  ContextSnapshot,
  ContextVariable,
} from "~/lib/async-context/runtime";
export {
  createPortableContextRuntime,
  installContextRuntime,
} from "~/lib/async-context/runtime";
export type {
  AutomationRecord,
  AutomationService,
} from "~/lib/automation";
export type {
  CommandResult,
  CommandSite,
  Exec,
  ExecOptions,
} from "~/lib/commands";
export { CommandError } from "~/lib/commands";
export type { ArgvArgument } from "~/lib/commands/argv";
export {
  fillArgv,
  parseArgv,
  placeholdersOf,
  shellQuote,
  showArgv,
} from "~/lib/commands/argv";
export type {
  AnyDefinition,
  LockedNode,
  NamedDefinition,
  SetupFn,
  StepFn,
  StepRecord,
  WorkflowRecord,
} from "~/lib/definitions";
export type {
  DefinitionEntry,
  MonitorRecord,
} from "~/lib/definitions/registry";
export type {
  AgentDefinition,
  AgentLike,
  AgentMcpServer,
  AgentRoute,
  Agents,
  ArtifactDefinition,
  Context,
  DeferredAgent,
  SandboxDefinition,
  Sandboxes,
  SandboxHandle,
  SandboxSpec,
  ScopedArtifacts,
  ScopedWorkspaces,
  Session,
  SessionOptions,
  SessionRef,
  WorkspaceDefinition,
  WorkspaceGit,
  WorkspaceHandle,
} from "~/lib/definitions/types";
export { SessionRouteError } from "~/lib/managers/agents";
export type {
  CliHarness,
  CliHarnessDescriptor,
  GuestArchitecture,
  GuestArtifact,
  GuestAuth,
  GuestFile,
  TurnExecutorRef,
} from "~/lib/managers/cli-harnesses";
export { CLI_HARNESS_IDS, CLI_HARNESSES } from "~/lib/managers/cli-harnesses";
export { TurnLimitUnsupportedError } from "~/lib/managers/session-options";
export type { ProviderEntry } from "~/lib/providers";
export { ProviderConfiguration } from "~/lib/providers";
export type {
  Execution,
  ProviderInstance,
  ProviderPlugin,
  ProviderScope,
  ProviderSetup,
  ProviderWorkspace,
} from "~/lib/providers/plugins";
export type {
  ProviderConfigurations,
  ProviderEntryRecord,
  ProviderStore,
  ProvidersFile,
  ProviderWrites,
} from "~/lib/providers/store";
export {
  ConfigurationError,
  MemoryProviderStore,
} from "~/lib/providers/store";
export type { RunRecord } from "~/lib/runs/records";
export type { ReadonlyRunScopes, RunScope } from "~/lib/runs/scope";
export { TERMINAL_RUN_STATUSES } from "~/lib/runs/store";
export type { SandboxAuthority, SandboxGuestSetup } from "~/lib/sandbox";
export type {
  Change,
  FileChange,
  HttpChange,
  MonitorContext,
  MonitorHandler,
  MonitorSpec,
} from "~/lib/schedule/monitor";
export type {
  CalendarSlot,
  Schedule,
  Trigger,
  Weekday,
} from "~/lib/schedule/triggers";
export type { Log, LogLevel, LogOrigin } from "~/lib/shared/log";
export type {
  DirectUsageFact,
  PriceBasis,
  RecordedUsageFact,
  RecordOutcome,
  RunUsageFact,
  UnattributedUsageFact,
  UnreadablePlaces,
  UsageCost,
  UsageFact,
  UsageLedger,
  UsageRecords,
  UsageTokens,
} from "~/lib/usage";
export * from "./embedded";
export type { FeedAnswer } from "./feed/entry";
export type {
  FeedEntrySnapshot,
  FeedMediaSnapshot,
  FeedReader,
} from "./feed/read";
export type { AgentsManager } from "./managers/agents";
export type { ArtifactsManager } from "./managers/artifacts";
export type {
  SandboxesManager,
  WorkspaceMaterialization,
} from "./managers/sandboxes";
export type {
  WorkspaceCatalogue,
  WorkspacesManager,
} from "./managers/workspaces";
export type { ActivityRecord, HarnessActivities } from "./sandbox/activities";
export type { HarnessInteractions } from "./sandbox/interactions";
