import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  hostHere,
  joinProcess,
  NotHostedError,
  withRunningWorkspace,
  withTasks,
} from "~/access/workspace";
import type { Flags } from "~/args";
import { listWorkspaces } from "~/lib/state/workspace";
import { onRelayGone, protocolOutput, SHUTDOWN_GRACE_MS } from "~/mcp/relay";
import { createMcpServer, type McpServerOptions } from "~/mcp/server";
import type { WorkspaceSummary } from "~/model/connection";
import type { WorkspaceHost } from "~/workspace/host";
import type { OpenedWorkspace } from "~/workspace/open";
import { findWorkspace, recordedWorkspace } from "~/workspace/open";
import { resolveSource } from "~/workspace/source";

const print = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** What the server answers for, and how to let go of it. */
interface Served extends McpServerOptions {
  readonly release: () => Promise<void>;
}

/** Nothing loaded at the source; said as it is, not as a load failure. */
class MissingSourceError extends Error {
  override readonly name = "MissingSourceError";
}

/** Under `--dry-run` nothing persists, so the workspace is hosted here. */
async function serveInProcess(flags: Flags): Promise<Served> {
  const host = await hostHere(flags, { askable: false, env: "require", print });
  if (host.config === null) {
    await host.close();
    throw new MissingSourceError(`no Marbles source at "${host.configPath}"`);
  }
  const only = (id: string): WorkspaceHost => {
    if (id !== host.id) {
      throw new Error(
        `only workspace "${host.id}" is available under --dry-run`
      );
    }
    return host;
  };
  return {
    hosted: (id, work) => work(only(id)),
    id: host.id,
    release: () => host.close(),
    tasks: (command, id = host.id) => only(id).tasks(command),
    workspaces: () =>
      Promise.resolve([
        { config: host.config, id: host.id, root: host.root, state: "ready" },
      ]),
  };
}

/**
 * Answer from stored state and the running Marbles process, joined per
 * call and never started. No source is needed: tasks work for any recorded
 * workspace either way, and everything that runs or reads a run needs a
 * worker that hosts the workspace.
 */
function serveFromState(flags: Flags): Served {
  const opened = findWorkspace(flags);
  const own = opened.workspace;
  // Each stored-state call holds the tasks until it ends, so calls a client
  // sends together take turns rather than refuse each other.
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = turn.then(work, work);
    turn = next.catch(() => undefined);
    return next;
  };
  const recorded = (id: string): OpenedWorkspace => {
    const found = id === own.id ? opened : recordedWorkspace(flags, id);
    if (found === undefined) {
      throw new Error(
        `no workspace "${id}" is recorded under ${resolve(flags.state)}; list_workspaces names them`
      );
    }
    return found;
  };
  return {
    async hosted(id, work) {
      try {
        return await withRunningWorkspace(flags, id, work);
      } catch (error) {
        if (
          error instanceof NotHostedError &&
          id === own.id &&
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
    id: own.id,
    release: () => Promise.resolve(),
    tasks: (command, id = own.id) => {
      const target = recorded(id);
      return inTurn(() =>
        withTasks(flags, target, print, (run) => run(command))
      );
    },
    async workspaces() {
      const client = await joinProcess(flags);
      let listed: readonly WorkspaceSummary[];
      if (client === undefined) {
        listed = listWorkspaces(resolve(flags.state)).map(
          ({ config, id, root }) => ({ config, id, root, state: "stopped" })
        );
      } else {
        try {
          listed = await client.workspaces();
        } finally {
          client.close();
        }
      }
      // This server's own workspace is always there to address.
      return listed.some((entry) => entry.id === own.id)
        ? listed
        : [
            {
              config: opened.config,
              id: own.id,
              root: own.root,
              state: "stopped",
            },
            ...listed,
          ];
    },
  };
}

/** Serve the workspace until the client leaves. */
async function serve(flags: Flags): Promise<void> {
  const output = protocolOutput();
  const configPath = resolveSource(flags.config);
  let served: Served;
  try {
    served = flags.dry ? await serveInProcess(flags) : serveFromState(flags);
  } catch (error) {
    if (error instanceof MissingSourceError) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `could not open the workspace for "${configPath}": ${reason}`,
      { cause: error }
    );
  }
  const server = createMcpServer(served);
  const close = async (): Promise<void> => {
    try {
      await server.close();
    } finally {
      await served.release();
    }
  };
  // A terminal signals the relay and this process together, and the relay
  // passes its copy on, so a repeat is expected and changes nothing. Work
  // that ignores cancellation cannot hold the shutdown past its deadline.
  let closing = false;
  const shutdown = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    setTimeout(() => {
      print(
        `marbles mcp: shutdown did not finish within ${SHUTDOWN_GRACE_MS}ms; exiting`
      );
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
    close()
      .catch((error: unknown) => {
        print(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      })
      .finally(() => {
        // The relay's pipe and stdin may still be open; neither holds the
        // process once every frame is out.
        output.end(() => process.exit());
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.once("end", shutdown);
  try {
    await server.connect(new StdioServerTransport(process.stdin, output));
  } catch (error) {
    await close();
    throw error;
  }
  onRelayGone(shutdown);
}

/**
 * A server that cannot start says why on stderr and exits non-zero; the
 * protocol stream stays empty. A source failure keeps its stack, which
 * points into the module that threw.
 */
function report(error: unknown): void {
  print(
    `marbles mcp: ${error instanceof Error ? error.message : String(error)}`
  );
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause !== undefined) {
    print(
      cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)
    );
  }
  process.exitCode = 1;
}

/** `marbles mcp`: serve MCP over STDIO until the client leaves. */
export async function serveStdio(flags: Flags): Promise<void> {
  await serve(flags).catch(report);
}
