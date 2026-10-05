/**
 * The lib entry, `@foundry/quirks/lib`: everything a host needs to run Quirks
 * definitions without the CLI. Build the five instances the `Engine` takes,
 * tell it what can run with `define`, `schedule` and `monitor`, start it, and
 * launch by name. The words a `quirks.config.ts` writes definitions with live
 * in the package's main entry; this one takes what they produce as data.
 *
 * The base classes those instances are built from are re-exported from here
 * too. The package bundles them, so these are the copies an instance has to
 * come from to be handed to the engine.
 */

export type { SessionStore } from "@foundry/agents/session";
// biome-ignore lint/performance/noBarrelFile: This is the public package entry point for programmatic hosts.
export { InMemorySessionStore } from "@foundry/agents/session";
export { ArtifactSystem, InMemoryArtifactStore } from "@foundry/artifacts";
export type { Provider, TurnExecutorRef } from "@foundry/models";
export { ModelManager } from "@foundry/models";
export type { Containers } from "@foundry/sandbox/container/containers";
export { createContainers } from "@foundry/sandbox/container/containers";
export { createMemoryContainerStore } from "@foundry/sandbox/container/store";
export { WorkspaceSystem } from "@foundry/workspaces";
export { git } from "@foundry/workspaces/git";
export { directory } from "@foundry/workspaces/node";
export { nodeObserver } from "@foundry/workspaces/node/watch";

export type { AutomationOptions } from "./automation/service";
export { AutomationService } from "./automation/service";
export type { Bindings, HostBindings, ManagerArgs } from "./bindings";
export type {
  AnyDefinition,
  LockedNode,
  SetupFn,
  StepFn,
  StepRecord,
  WorkflowRecord,
} from "./definition";
export { isLockedNode, rootLock } from "./definition";
export type { EngineOptions } from "./engine";
export { Engine } from "./engine";
export type { FeedAnswer } from "./feed/entry";
export type { FeedPublisher } from "./feed/publish";
export type {
  FeedEntrySnapshot,
  FeedMediaSnapshot,
  FeedReader,
} from "./feed/read";
export {
  availableExecutors,
  detectHarnesses,
  harnessModels,
  selectExecutor,
  selectedHarnesses,
} from "./harnesses";
export type { Log, LogLevel } from "./log";
export { createLog } from "./log";
export type { AgentsDeps } from "./managers/agents";
export { AgentsManager } from "./managers/agents";
export type { ArtifactsDeps } from "./managers/artifacts";
export { ArtifactsManager } from "./managers/artifacts";
export type { SandboxesDeps } from "./managers/sandboxes";
export { allowedMountRoots, SandboxesManager } from "./managers/sandboxes";
export { globalSkillsDir, skillResolver } from "./managers/skills";
export type { Catalogue, WorkspacesDeps } from "./managers/workspaces";
export { WorkspacesManager } from "./managers/workspaces";
export type {
  Change,
  FileChange,
  HttpChange,
  MonitorContext,
  MonitorHandler,
  MonitorSpec,
} from "./monitor";
export { detector } from "./monitor";
export type { DefinitionEntry } from "./registry";
export { HarnessActivities } from "./sandbox/activities";
export { HarnessInteractions } from "./sandbox/interactions";
export type { LoopOptions, TickOptions } from "./schedule";
export { nextDue, parseAt, runSchedules, tick } from "./schedule";
export { JsonSessionStore } from "./sessions/json-store";
export type { Workspace } from "./state/workspace";
export { workspaceState } from "./state/workspace";
export type { CalendarSlot, Schedule, Trigger, Weekday } from "./triggers";
export type {
  AgentDefinition,
  Agents,
  ArtifactDefinition,
  Artifacts,
  Context,
  SandboxDefinition,
  Sandboxes,
  SandboxSpec,
  Session,
  SessionRef,
  WorkspaceDefinition,
  Workspaces,
} from "./types";
