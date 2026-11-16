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
import { recordedWorkspaces } from "~/database/workspaces";
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
        session = withTasks(flags, opened, (run) => {
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

function serveWorkspace(flags: Flags): Served {
  const opened = findWorkspace(flags);
  const own = opened.workspace;
  const memory = flags.dry ? sessionTasks(flags, opened) : undefined;
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = turn.then(work, work);
    turn = next.catch(() => undefined);
    return next;
  };
  const recorded = async (id: string): Promise<OpenedWorkspace> => {
    if (id === own.id) {
      return opened;
    }
    if (flags.dry) {
      throw new Error(
        `only workspace "${own.id}" is available under --dry-run`
      );
    }
    const found = await recordedWorkspace(flags, id);
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
    release: () => turn.then(() => memory?.release()),
    tasks: (command, id = own.id) =>
      inTurn(async () => {
        const target = await recorded(id);
        return memory === undefined
          ? withTasks(flags, target, (run) => run(command))
          : (await memory.open())(command);
      }),
    async workspaces() {
      if (flags.dry) {
        return [ownSummary];
      }
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
      return listed.some((entry) => entry.id === own.id)
        ? listed
        : [ownSummary, ...listed];
    },
  };
}

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

export async function serveStdio(flags: Flags): Promise<void> {
  await serve(flags).catch(report);
}
