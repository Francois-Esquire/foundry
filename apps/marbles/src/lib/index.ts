/**
 * The lib entry, `@foundry/marbles/lib`: the `Engine`, the types it speaks,
 * and the package classes its five instances are built from. Build those,
 * hand them to the engine, tell it what can run with `define`, `schedule`
 * and `monitor`, start it, and launch by name; or call its managers
 * directly. The words a `marbles.config.ts` writes definitions with live in
 * the package's main entry; this one takes what they produce as data.
 *
 * The package classes are re-exported because the package bundles them:
 * these are the copies an instance has to come from to be handed to the
 * engine.
 */

// `sessions`: where agent transcripts live.
export type { SessionStore } from "@foundry/agents/session";
// biome-ignore lint/performance/noBarrelFile: This is the public package entry point for programmatic hosts.
export { InMemorySessionStore } from "@foundry/agents/session";
// `artifacts`: versioned outputs and the feed.
export { ArtifactSystem, InMemoryArtifactStore } from "@foundry/artifacts";
export { blobFiles, JsonArtifactStore } from "@foundry/artifacts/node";
// `models`: the providers agents route to.
export type { Provider, TurnExecutorRef } from "@foundry/models";
export { ModelManager } from "@foundry/models";
export { claudeCodeProvider } from "@foundry/models/claude-code";
export { codexProvider } from "@foundry/models/codex";
// `containers`: where sandboxes run.
export type { Containers } from "@foundry/sandbox/container/containers";
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
  AnyDefinition,
  LockedNode,
  SetupFn,
  StepFn,
  StepRecord,
  WorkflowRecord,
} from "./definition";
export type { EngineOptions } from "./engine";
export { Engine } from "./engine";
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
export type { ActivityRecord, HarnessActivities } from "./sandbox/activities";
export type { HarnessInteractions } from "./sandbox/interactions";
export { JsonSessionStore } from "./sessions/json-store";
export type { CalendarSlot, Schedule, Trigger, Weekday } from "./triggers";
export type {
  AgentDefinition,
  Agents,
  ArtifactDefinition,
  Artifacts,
  Context,
  Sandbox,
  SandboxDefinition,
  Sandboxes,
  SandboxSpec,
  Session,
  SessionOptions,
  SessionRef,
  WorkspaceDefinition,
  WorkspaceHandle,
  Workspaces,
} from "./types";
