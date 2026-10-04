import type { Log } from "~/lib/log";

import type { AgentsManager } from "./managers/agents";
import type { ArtifactsManager } from "./managers/artifacts";
import type { SandboxesManager } from "./managers/sandboxes";
import type { Catalogue, WorkspacesManager } from "./managers/workspaces";
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
  /** Absent when the engine has no workspaces manager; file monitors need it. */
  readonly catalogue?: Catalogue;
  /** The workspace state dir; undefined under `--dry`. */
  readonly state?: string;
}

export interface Bindings {
  readonly agents: (args: ManagerArgs) => Agents;
  readonly artifacts: (args: ManagerArgs) => Artifacts;
  readonly host?: HostBindings;
  /** Host output for `log(...)`. */
  readonly log: Log;
  /** The config's directory. */
  readonly root: string;
  readonly sandboxes: (args: ManagerArgs) => Sandboxes;
  readonly workspaces: (args: ManagerArgs) => Workspaces;
}

/** The manager instances an engine is given; each is built outside it. */
export interface Managers {
  readonly agents?: AgentsManager;
  readonly artifacts?: ArtifactsManager;
  readonly sandboxes?: SandboxesManager;
  readonly workspaces?: WorkspacesManager;
}

export interface BindOptions extends Managers {
  readonly log: Log;
  readonly root: string;
  readonly state?: string;
}

/** A manager that refuses every call: for hosts that have not wired one. */
export function unbound<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get(_target, property) {
      if (property === "then") {
        return;
      }
      throw new Error(`${name} is not available in this host`);
    },
  });
}

/**
 * The bindings over a set of manager instances. A manager left out refuses
 * every call, so a host wires only what its definitions use.
 */
export function bindManagers({
  agents,
  artifacts,
  log,
  root,
  sandboxes,
  state,
  workspaces,
}: BindOptions): Bindings {
  return {
    agents: (args) => agents?.scoped(args) ?? unbound("agents"),
    artifacts: (args) => artifacts?.scoped(args) ?? unbound("artifacts"),
    host: { catalogue: workspaces?.catalogue, state },
    log,
    root,
    sandboxes: (args) => sandboxes?.scoped(args) ?? unbound("sandboxes"),
    workspaces: (args) => workspaces?.scoped(args) ?? unbound("workspaces"),
  };
}
