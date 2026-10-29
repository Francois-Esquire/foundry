/**
 * The workspace entry, `@foundry.sh/marbles/workspace`: host one workspace
 * in this process, without the CLI. `hostWorkspace` loads the source,
 * builds and starts the engine, and returns the `WorkspaceConnection` the
 * dashboard, the CLI, and MCP are written against; `run` ticks its
 * triggers until a signal aborts. `watchSource` says when the source
 * changed, `createStarter` writes a starter module, and `layout` decides
 * where everything lives.
 */

// biome-ignore lint/performance/noBarrelFile: This is the public package entry point for single-workspace hosts.
export { type Layout, type LayoutOptions, layout } from "~/layout";
export type {
  DispatchInfo,
  DispatchOptions,
  RollResult,
  RunControls,
  RunInfo,
  WorkspaceActions,
  WorkspaceConfig,
  WorkspaceConnection,
  WorkspaceState,
  WorkspaceSummary,
} from "~/model/connection";
export type { DashboardSnapshot } from "~/model/dashboard";
export { createStarter } from "~/workspace/create";
export { EnvironmentError } from "~/workspace/env";
export {
  type HostWorkspaceOptions,
  hostWorkspace,
  LaunchInputError,
  type WorkspaceHost,
} from "~/workspace/host";
export { runSchedulesUntilStopped } from "~/workspace/loop";
export { findWorkspace, type OpenedWorkspace } from "~/workspace/open";
export { DEFAULT_SOURCE, sourceRoot } from "~/workspace/source";
export { type SetupDraft, STARTERS } from "~/workspace/templates";
export { sourceDigest, watchSource } from "~/workspace/watch";
