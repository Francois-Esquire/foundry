import { TaskError, Tasks } from "@foundry/tasks";
import type { ResourceKind } from "~/lib/resources";
import { runSteps } from "~/lib/run-trace";
import { ToolRefusal } from "~/mcp/errors";
import type { McpServerOptions } from "~/mcp/resources";
import type { WorkspaceConnection, WorkspaceSummary } from "~/model/connection";
import { NotHostedError } from "~/model/errors";
import type {
  TaskCommand,
  TaskCommandKind,
  TaskCommandResult,
} from "~/model/tasks";
import type {
  ArtifactResourceItem,
  MarblesService,
  MarblesServiceOptions,
  ResourceItem,
  ResourceOwnership,
  ResourceReader,
  RunResourceItem,
  SandboxResourceItem,
  SessionResourceItem,
} from "~/service/ports";
import {
  type MarblesStorage,
  type ResourceScope,
  resourceRefKey,
  type ShownResource,
} from "~/storage/ports";
import { runTaskCommand } from "~/workspace/tasks";

function ownership(shown: ShownResource<unknown>): ResourceOwnership {
  const [owner = "", ...sharedWith] = shown.workspaces;
  return { id: shown.ref.id, owner, sharedWith };
}

function iso(at: number | Date): string {
  return new Date(at).toISOString();
}

async function artifactItems(
  storage: MarblesStorage,
  scope: ResourceScope
): Promise<readonly ArtifactResourceItem[]> {
  return (await storage.artifacts(scope)).map((shown) => ({
    ...ownership(shown),
    name: shown.value.name,
    status: shown.value.status,
    type: shown.value.type,
    updatedAt: iso(shown.value.updatedAt),
  }));
}

async function runItems(
  storage: MarblesStorage,
  scope: ResourceScope,
  limit?: number
): Promise<readonly RunResourceItem[]> {
  return (await storage.runs(scope, limit)).map((shown) => {
    const { record } = shown.value;
    return {
      ...ownership(shown),
      createdAt: iso(record.timestamps.createdAt),
      id: record.id,
      status: record.status,
      step: record.step,
      steps: runSteps(record),
    };
  });
}

async function sandboxItems(
  storage: MarblesStorage,
  scope: ResourceScope
): Promise<readonly SandboxResourceItem[]> {
  return (await storage.sandboxes(scope)).map((shown) => ({
    ...ownership(shown),
    createdAt: iso(shown.value.createdAt),
    status: shown.value.status,
  }));
}

async function sessionItems(
  storage: MarblesStorage,
  scope: ResourceScope
): Promise<readonly SessionResourceItem[]> {
  const sessions = await storage.sessions(scope);
  const tallies = await storage.messageTallies(sessions.map(({ ref }) => ref));
  return sessions.map((shown) => {
    const tally = tallies.get(resourceRefKey(shown.ref));
    return {
      ...ownership(shown),
      messages: tally?.messages ?? 0,
      summarized: Boolean(tally?.summarized),
      updatedAt: iso(shown.value.updatedAt),
    };
  });
}

function reader<T extends ResourceItem>(
  list: (scope: ResourceScope) => Promise<readonly T[]>
): ResourceReader<T> {
  return {
    get: async (scope, id) =>
      (await list(scope)).find((item) => item.id === id),
    list,
  };
}

export function createMarblesService(
  options: MarblesServiceOptions
): MarblesService {
  const { execution, storage } = options;

  const hosted = <T>(
    workspaceId: string,
    work: (workspace: WorkspaceConnection) => Promise<T>
  ): Promise<T> => {
    if (execution === undefined) {
      return Promise.reject(
        new NotHostedError(
          `nothing hosts workspace ${workspaceId}; this Marbles service has no execution backend`
        )
      );
    }
    return execution.hosted(workspaceId, work);
  };

  const runTasks = async <K extends TaskCommandKind>(
    workspaceId: string,
    command: TaskCommand<K>
  ): Promise<TaskCommandResult<K>> => {
    if (execution?.tasks !== undefined) {
      return execution.tasks(workspaceId, command);
    }
    const store = (await storage.forWorkspace(workspaceId)).tasks;
    return runTaskCommand(new Tasks({ store }), command);
  };

  const listWorkspaces = async (): Promise<readonly WorkspaceSummary[]> => {
    const live = execution === undefined ? [] : await execution.workspaces();
    const known = new Set(live.map(({ id }) => id));
    const stopped = (await storage.workspaces.list())
      .filter(({ id }) => !known.has(id))
      .map(
        ({ config, id, root }): WorkspaceSummary => ({
          config,
          id,
          root,
          state: "stopped",
        })
      );
    return [...live, ...stopped.sort((a, b) => a.id.localeCompare(b.id))];
  };

  const artifacts: ResourceReader<ArtifactResourceItem> = {
    async get(scope, id) {
      const found = (await artifactItems(storage, scope)).find(
        (item) => item.id === id
      );
      if (found === undefined) {
        return;
      }
      const files = await storage.artifactFiles({
        id,
        kind: "artifact",
        owner: found.owner,
      });
      return { ...found, files };
    },
    list: (scope) => artifactItems(storage, scope),
  };
  const sandboxes = reader((scope) => sandboxItems(storage, scope));
  const sessions = reader((scope) => sessionItems(storage, scope));
  const runs = reader((scope) => runItems(storage, scope));

  const readers: {
    readonly [K in ResourceKind]: ResourceReader<ResourceItem>;
  } = {
    artifact: artifacts,
    run: runs,
    sandbox: sandboxes,
    session: sessions,
  };

  const service: MarblesService = {
    agents: {
      dispatch: (workspaceId, dispatch) =>
        hosted(workspaceId, (workspace) => workspace.dispatchAgent(dispatch)),
    },
    artifacts,
    resources: {
      get: (kind, scope, id) => readers[kind].get(scope, id),
      list: (kind, scope) => readers[kind].list(scope),
    },
    runs: {
      cancel: (workspaceId, runId) =>
        hosted(workspaceId, (workspace) => workspace.cancelRun(runId)),
      enqueue: (workspaceId, name, input, enqueue) =>
        hosted(workspaceId, (workspace) =>
          workspace.dispatchWorkflow(name, input, enqueue)
        ),
      get: runs.get,
      list: (scope, limit) => runItems(storage, scope, limit),
    },
    sandboxes,
    sessions,
    tasks: {
      change: (workspaceId, change) =>
        runTasks(workspaceId, { change, kind: "change" }),
      async get(workspaceId, id, depth) {
        try {
          return await runTasks(workspaceId, {
            id,
            kind: "get",
            ...(depth === undefined ? {} : { depth }),
          });
        } catch (error) {
          if (error instanceof TaskError && error.code === "not_found") {
            return;
          }
          throw error;
        }
      },
      list: (workspaceId, query = {}) =>
        runTasks(workspaceId, { kind: "list", query }),
      run: runTasks,
    },
    toMcpOptions(defaultWorkspace) {
      const own = defaultWorkspace ?? options.defaultWorkspace;
      const mcp: McpServerOptions = {
        hosted,
        ...(own === undefined ? {} : { id: own }),
        tasks: (command, workspace) => {
          const target = workspace ?? own;
          if (target === undefined) {
            return Promise.reject(
              new ToolRefusal(
                "invalid_argument",
                "workspace is required when no default workspace is active; list (resource: workspaces) names them"
              )
            );
          }
          return runTasks(target, command);
        },
        workspaces: listWorkspaces,
      };
      return mcp;
    },
    workspaces: {
      definitions: (workspaceId) =>
        hosted(
          workspaceId,
          async (workspace) => (await workspace.describe()).definitions
        ),
      get: async (id) =>
        (await listWorkspaces()).find((workspace) => workspace.id === id),
      list: listWorkspaces,
    },
  };
  return service;
}
