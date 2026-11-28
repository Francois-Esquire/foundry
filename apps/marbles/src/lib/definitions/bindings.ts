import type { Exec } from "~/lib/commands";
import type {
  Agents,
  Sandboxes,
  ScopedArtifacts,
  ScopedWorkspaces,
} from "~/lib/definitions/types";
import type { AgentTurns } from "~/lib/managers/agents";
import type { Runs } from "~/lib/managers/runs";
import type { WorkspaceCatalogue } from "~/lib/managers/workspaces";
import type { ExecutionContext } from "~/lib/runs/context";
import type { Frame, RunScope } from "~/lib/runs/scope";
import type { TriggerStore } from "~/lib/schedule/store";
import type { Log } from "~/lib/shared/log";

export interface ManagerArgs {
  readonly frame: Frame;
  readonly scope: RunScope;
  readonly write: (value: unknown) => void;
}

export interface HostBindings {
  readonly catalogue?: WorkspaceCatalogue;
  readonly triggers?: TriggerStore;
}

export interface Bindings {
  readonly agents: (args: ManagerArgs) => Agents;
  readonly artifacts: (args: ManagerArgs) => ScopedArtifacts;
  readonly context?: ExecutionContext;
  readonly exec?: (args: ManagerArgs) => Exec;
  readonly host?: HostBindings;
  readonly log: Log;
  readonly resolveFeedMedia?: (path: string) => string;
  readonly root: string;
  readonly runs?: (args?: ManagerArgs) => Runs;
  readonly sandboxes: (args: ManagerArgs) => Sandboxes;
  readonly setupLog?: (run: {
    readonly id: string;
    readonly workflow: string;
  }) => Log;
  readonly turns?: (args?: ManagerArgs) => AgentTurns;
  readonly workspaces: (args: ManagerArgs) => ScopedWorkspaces;
}
