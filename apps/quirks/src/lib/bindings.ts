import type { Log } from "~/lib/log";

import type { Catalogue } from "./managers/workspaces";
import type { Frame, RunScope } from "./run-scope";
import type { Agents, Artifacts, Sandboxes, Workspaces } from "./types";

/**
 * What a step body's context is built from: the four package-backed
 * managers, scoped to one frame so each can attach to the frame's signal,
 * stream, and working directory, and where output goes.
 */
export interface ManagerArgs {
  readonly cwd: string;
  readonly frame: Frame;
  readonly scope: RunScope;
  readonly write: (value: unknown) => void;
}

/** Host-only facilities that never reach authored code. */
export interface HostBindings {
  /** The workspace system; file monitors read the tree through it. */
  readonly catalogue?: Catalogue;
  /** The workspace state dir; undefined when nothing is persisted. */
  readonly state?: string;
}

/** The engine's managers, as a step body reaches them. */
export interface Bindings {
  readonly agents: (args: ManagerArgs) => Agents;
  readonly artifacts: (args: ManagerArgs) => Artifacts;
  readonly host?: HostBindings;
  /** Host output for `log(...)`. */
  readonly log: Log;
  /** The workspace root. */
  readonly root: string;
  readonly sandboxes: (args: ManagerArgs) => Sandboxes;
  readonly workspaces: (args: ManagerArgs) => Workspaces;
}
