import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  joinProcess,
  NotHostedError,
  type TaskRunner,
  withRunningWorkspace,
  withTasks,
} from "~/access/workspace";
import type { Flags } from "~/args";
import { listWorkspaces } from "~/lib/state/workspace";
import { onRelayGone, protocolOutput, SHUTDOWN_GRACE_MS } from "~/mcp/relay";
import { createMcpServer, type McpServerOptions } from "~/mcp/server";
import type { WorkspaceSummary } from "~/model/connection";
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

/**
 * Under `--dry-run` the tasks are in memory, so the session keeps one
 * engine over them: opened by the first task call, given up at release.
 * It is the same stored-task access as without `--dry-run`, held longer.
 * An open that fails is tried again by the next call.
 */
function sessionTasks(flags: Flags, opened: OpenedWorkspace) {
  let runner: Promise<TaskRunner> | undefined;
  let session: Promise<void> = Promise.resolve();
  let letGo = (): void => undefined;
  return {
    open(): Promise<TaskRunner> {
      runner ??= new Promise<TaskRunner>((ready, fail) => {
        const done = new Promise<void>((end) => {
          letGo = end;
        });
        let held = false;
        session = withTasks(flags, opened, print, (run) => {
          held = true;
          ready(run);
          return done;
        }).catch((error: unknown) => {
          if (held) {
            throw error;
          }
          runner = undefined;
          fail(error);
        });
      });
      return runner;
    },
    release(): Promise<void> {
      letGo();
      return session;
    },
  };
}

/**
 * Answer from stored state and the running Marbles process, joined per
 * call and never started. No source is loaded: tasks work for any recorded
 * workspace either way, and everything that runs or reads a run needs a
 * worker that hosts the workspace. Under `--dry-run` only this server's
 * own workspace is addressable, its tasks are in memory, and no Marbles
 * process is joined, so nothing that runs or reads a run is served.
 */
function serveWorkspace(flags: Flags): Served {
  const opened = findWorkspace(flags);
  const own = opened.workspace;
  const memory = flags.dry ? sessionTasks(flags, opened) : undefined;
  // Each stored-state call holds the tasks until it ends, so calls a client
  // sends together take turns rather than refuse each other.
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = turn.then(work, work);
    turn = next.catch(() => undefined);
    return next;
  };
  const recorded = (id: string): OpenedWorkspace => {
    if (id === own.id) {
      return opened;
    }
    if (flags.dry) {
      throw new Error(
        `only workspace "${own.id}" is available under --dry-run`
      );
    }
    const found = recordedWorkspace(flags, id);
    if (found === undefined) {
      throw new Error(
        `no workspace "${id}" is recorded under ${resolve(flags.state)}; list_workspaces names them`
      );
    }
    return found;
  };
  const ownSummary: WorkspaceSummary = {
    config: opened.config,
    id: own.id,
    root: own.root,
    state: "stopped",
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
    // A call already holding the tasks finishes before the server exits.
    release: () => turn.then(() => memory?.release()),
    tasks: (command, id = own.id) => {
      const target = recorded(id);
      return inTurn(async () =>
        memory === undefined
          ? withTasks(flags, target, print, (run) => run(command))
          : (await memory.open())(command)
      );
    },
    async workspaces() {
      if (flags.dry) {
        return [ownSummary];
      }
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
        : [ownSummary, ...listed];
    },
  };
}

/** Serve the workspace until the client leaves. */
async function serve(flags: Flags): Promise<void> {
  const output = protocolOutput();
  const configPath = resolveSource(flags.config);
  let served: Served;
  try {
    served = serveWorkspace(flags);
  } catch (error) {
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
 * protocol stream stays empty. A failure's cause keeps its stack.
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
