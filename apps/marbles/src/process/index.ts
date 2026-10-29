/**
 * The process entry, `@foundry.sh/marbles/process`: the one Marbles
 * process for a machine, and how to be its client. `startDaemon` claims
 * the state root, listens on the layout's socket, and hosts each attached
 * workspace in a worker of its own; `connect` joins the running daemon, or
 * starts one, and hands back the `WorkspaceConnection` for any workspace
 * it hosts. Neither side imports an authoring module: only a worker does.
 *
 *     const client = await connect({ layout: layout() });
 *     const summary = await client.attach("/path/to/project/.foundry/marbles");
 *     const workspace = client.workspace(summary);
 *     const snapshot = await workspace.snapshot();
 */

// biome-ignore lint/performance/noBarrelFile: This is the public package entry point for programmatic hosts.
export { type Layout, type LayoutOptions, layout } from "~/layout";
export type {
  WorkspaceConnection,
  WorkspaceState,
  WorkspaceSummary,
} from "~/model/connection";
export {
  type AttachOptions,
  type ConnectOptions,
  connect,
  type Disconnect,
  daemonAlive,
  describeDisconnect,
  type MarblesClient,
  NoProcessError,
  type SubscriptionHandlers,
} from "./client";
export { type Daemon, type DaemonOptions, startDaemon } from "./daemon";
export {
  claimProcess,
  ProcessHeldError,
  type ProcessHost,
  type ProcessInfo,
  type ProcessInstance,
  type ProcessStatus,
  readProcess,
} from "./instance";
export { type HelloResult, RemoteError } from "./protocol";
