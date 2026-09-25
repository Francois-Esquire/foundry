import type { Log } from "~/lib/log";

import type { Catalogue } from "./managers/workspaces";
import type { Frame, RunScope } from "./run-scope";
import type { Agents, Artifacts, Sandboxes, Workspaces } from "./types";

/**
 * What the host binds after the config imports and before anything runs:
 * the factories for the four package-backed context keys, and where output
 * goes. Each manager is created per frame so it can attach to the frame's
 * signal, stream, and working directory.
 */
export interface ManagerArgs {
  readonly cwd: string;
  readonly frame: Frame;
  readonly scope: RunScope;
  readonly write: (value: unknown) => void;
}

/** Host-only facilities that never reach authored code. */
export interface HostBindings {
  readonly catalogue: Catalogue;
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
