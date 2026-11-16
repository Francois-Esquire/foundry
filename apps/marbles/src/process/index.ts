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
  ProcessMismatchError,
  ProcessTimeoutError,
  type StopProcessOptions,
  type SubscriptionHandlers,
  stopProcess,
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
