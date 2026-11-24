import type { Log } from "~/lib/log";
import type { TriggerStore } from "~/lib/trigger-store";

import type { Exec } from "./command";
import type { ExecutionContext } from "./execution-context";
import type { AgentTurns } from "./managers/agents";
import type { Runs } from "./managers/runs";
import type { Catalogue } from "./managers/workspaces";
import type { Frame, RunScope } from "./run-scope";
import type { Agents, Artifacts, Sandboxes, Workspaces } from "./types";

export interface ManagerArgs {
  readonly frame: Frame;
  readonly scope: RunScope;
  readonly write: (value: unknown) => void;
}

export interface HostBindings {
  readonly catalogue?: Catalogue;
  readonly triggers?: TriggerStore;
}

export interface Bindings {
  readonly agents: (args: ManagerArgs) => Agents;
  readonly artifacts: (args: ManagerArgs) => Artifacts;
  readonly context?: ExecutionContext;
  readonly exec?: (args: ManagerArgs) => Exec;
  readonly host?: HostBindings;
  readonly log: Log;
  readonly root: string;
  readonly runs?: (args?: ManagerArgs) => Runs;
  readonly sandboxes: (args: ManagerArgs) => Sandboxes;
  readonly setupLog?: (run: {
    readonly id: string;
    readonly workflow: string;
  }) => Log;
  readonly turns?: (args?: ManagerArgs) => AgentTurns;
  readonly workspaces: (args: ManagerArgs) => Workspaces;
}
