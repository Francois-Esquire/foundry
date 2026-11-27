import { resolve } from "node:path";
import type { GlobalFlags } from "~/cli/context";
import { readDatabase, recordedWorkspaces } from "~/database/open";
import { stateDatabase } from "~/layout";
import { causingRun } from "~/lib/events/records";
import { ToolRefusal } from "~/mcp/errors";
import type { McpServerOptions } from "~/mcp/resources";
import type { WorkspaceSummary } from "~/model/connection";
import { NotHostedError } from "~/model/errors";
import { joinProcess, withRunningWorkspace, withTasks } from "~/process/access";
import { createMarblesService } from "~/service/marbles";
import type { ExecutionBackend, MarblesService } from "~/service/ports";
import { MemoryMarblesStorage } from "~/storage/memory";
import { SqliteMarblesStorage } from "~/storage/sqlite";
import type { OpenedWorkspace } from "~/workspace/open";
import { findWorkspace, recordedWorkspace } from "~/workspace/open";

export function readLocalService<T>(
  state: string,
  work: (service: MarblesService) => Promise<T>
): Promise<T | undefined> {
  return readDatabase(stateDatabase(state), (database) =>
    work(
      createMarblesService({
        storage: new SqliteMarblesStorage({
          causingRun: () => causingRun() ?? undefined,
          database,
          state,
        }),
      })
    )
  );
}

async function defaultWorkspace(
  flags: GlobalFlags
): Promise<OpenedWorkspace | undefined> {
  const opened = findWorkspace(flags);
  if (flags.sourceExplicit || opened.config !== null) {
    return opened;
  }
  try {
    return await recordedWorkspace(flags, opened.workspace.id);
  } catch {
    return undefined;
  }
}

export interface LocalMcpService {
  readonly mcpOptions: McpServerOptions;
  readonly release: () => Promise<void>;
  readonly service: MarblesService;
}

export async function createLocalMcpService(
  flags: GlobalFlags
): Promise<LocalMcpService> {
  const opened = await defaultWorkspace(flags);
  const own = opened?.workspace;
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = turn.then(work, work);
    turn = next.catch(() => undefined);
    return next;
  };
  const recorded = async (id: string): Promise<OpenedWorkspace> => {
    if (opened !== undefined && id === opened.workspace.id) {
      return opened;
    }
    const found = await recordedWorkspace(flags, id);
    if (found === undefined) {
      throw new ToolRefusal(
        "not_found",
        `no workspace "${id}" is recorded under ${resolve(flags.state)}; list (resource: workspaces) names them`
      );
    }
    return found;
  };
  const ownSummary: WorkspaceSummary | undefined =
    opened === undefined
      ? undefined
      : {
          config: opened.config,
          id: opened.workspace.id,
          root: opened.workspace.root,
          state: "stopped",
        };
  const execution: ExecutionBackend = {
    async hosted(id, work) {
      try {
        return await withRunningWorkspace(flags, id, work);
      } catch (error) {
        if (
          error instanceof NotHostedError &&
          opened !== undefined &&
          id === opened.workspace.id &&
          opened.config === null
        ) {
          throw new NotHostedError(
            `no Marbles source at "${opened.configPath}"; ${error.message}`,
            { cause: error }
          );
        }
        throw error;
      }
    },
    tasks: (workspaceId, command) =>
      inTurn(async () => {
        const target = await recorded(workspaceId);
        return withTasks(flags, target, (run) => run(command));
      }),
    async workspaces() {
      const client = await joinProcess();
      let listed: readonly WorkspaceSummary[];
      if (client === undefined) {
        listed = (await recordedWorkspaces(flags.state)).map(
          ({ config, id, root }) => ({ config, id, root, state: "stopped" })
        );
      } else {
        try {
          listed = await client.workspaces();
        } finally {
          client.close();
        }
      }
      if (ownSummary === undefined) {
        return listed;
      }
      return listed.some((entry) => entry.id === ownSummary.id)
        ? listed
        : [ownSummary, ...listed];
    },
  };
  const service = createMarblesService({
    ...(own === undefined ? {} : { defaultWorkspace: own.id }),
    execution,
    storage: new MemoryMarblesStorage(),
  });
  return {
    mcpOptions: service.toMcpOptions(own?.id),
    release: () => turn.then(() => undefined),
    service,
  };
}
