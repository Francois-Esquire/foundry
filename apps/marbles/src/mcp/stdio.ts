import { Console } from "node:console";
import { resolve } from "node:path";
import { Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  hostHere,
  joinProcess,
  withRunningWorkspace,
  withTasks,
} from "~/access/workspace";
import type { Flags } from "~/args";
import { createMcpServer, type McpServerOptions } from "~/mcp/server";
import type { WorkspaceSummary } from "~/model/connection";
import { readStatus } from "~/status/model";
import type { WorkspaceHost } from "~/workspace/host";
import { findWorkspace } from "~/workspace/open";
import { resolveSource } from "~/workspace/source";

// Imported source and workflow bodies may print. Only the transport writes
// to the original stdout; everything else goes to stderr. The CLI loads this
// module only for `marbles mcp`, after its own imports.
const protocolWrite = process.stdout.write.bind(process.stdout);
const protocolOutput = new Writable({
  write(chunk, encoding, callback) {
    protocolWrite(chunk, encoding, callback);
  },
});
const diagnosticWrite = process.stderr.write.bind(process.stderr);
process.stdout.write = diagnosticWrite;
// evlog binds stdout's write when it loads, before this redirect, and
// pretty-prints model turns there. It reads this slot first on every write.
Object.assign(globalThis, { __evlogNativeStdoutWrite: diagnosticWrite });
Object.assign(
  globalThis.console,
  new Console({
    stderr: process.stderr,
    stdout: process.stderr,
  })
);
const print = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** What the server answers for, and how to let go of it. */
interface Served extends McpServerOptions {
  /** The source that defines the workspace, or null without one. */
  readonly config: string | null;
  /** Where the source is, or would be; named when nothing loads there. */
  readonly configPath: string;
  readonly release: () => Promise<void>;
}

/** Under `--dry-run` nothing persists, so the workspace is hosted here. */
async function serveInProcess(flags: Flags): Promise<Served> {
  const host = await hostHere(flags, { askable: false, env: "require", print });
  const only = (id: string): WorkspaceHost => {
    if (id !== host.id) {
      throw new Error(
        `only workspace "${host.id}" is available under --dry-run`
      );
    }
    return host;
  };
  return {
    config: host.config,
    configPath: host.configPath,
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
 * call and never started. Tasks work either way; everything that runs or
 * reads a run needs a worker that hosts the workspace.
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
  return {
    config: opened.config,
    configPath: opened.configPath,
    hosted: (id, work) => withRunningWorkspace(flags, id, work),
    id: own.id,
    release: () => Promise.resolve(),
    tasks: (command, id = own.id) =>
      id === own.id
        ? inTurn(() => withTasks(flags, opened, print, (run) => run(command)))
        : withRunningWorkspace(flags, id, (workspace) =>
            workspace.tasks(command)
          ),
    async workspaces() {
      const client = await joinProcess(flags);
      let listed: readonly WorkspaceSummary[];
      if (client === undefined) {
        listed = storedWorkspaces(flags.state);
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

/** The workspaces kept under the state root; none is hosted while no process runs. */
function storedWorkspaces(state: string): WorkspaceSummary[] {
  return readStatus(resolve(state)).workspaces.map(({ config, id, root }) => ({
    config,
    id,
    root,
    state: "stopped",
  }));
}

/** Serve the workspace until the client leaves. */
async function serve(flags: Flags): Promise<void> {
  const configPath = resolveSource(flags.config);
  let served: Served;
  try {
    served = flags.dry ? await serveInProcess(flags) : serveFromState(flags);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `could not open the workspace for "${configPath}": ${reason}`,
      { cause: error }
    );
  }
  if (served.config === null) {
    await served.release();
    throw new Error(`no Marbles source at "${served.configPath}"`);
  }
  const server = createMcpServer(served);
  const close = async (): Promise<void> => {
    try {
      await server.close();
    } finally {
      await served.release();
    }
  };
  const shutdown = (): void => {
    close().catch((error: unknown) => {
      print(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.once("end", shutdown);
  try {
    await server.connect(
      new StdioServerTransport(process.stdin, protocolOutput)
    );
  } catch (error) {
    await close();
    throw error;
  }
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
