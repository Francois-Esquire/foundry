#!/usr/bin/env bun
import { Console } from "node:console";
import { Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Flags } from "~/args";
import { parseMcpArgs } from "~/args";
import { layout } from "~/layout";
import { createMcpServer, type McpServerOptions } from "~/mcp/server";
import type { WorkspaceSummary } from "~/model/connection";
import { connect } from "~/process/client";
import { hostWorkspace } from "~/workspace/host";
import { resolveSource } from "~/workspace/source";

// Imported source and workflow bodies may print. Only the transport writes
// to the original stdout; everything else goes to stderr.
const protocolWrite = process.stdout.write.bind(process.stdout);
const protocolOutput = new Writable({
  write(chunk, encoding, callback) {
    protocolWrite(chunk, encoding, callback);
  },
});
process.stdout.write = process.stderr.write.bind(process.stderr);
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
  /** Where the source is, or would be; named when nothing loads there. */
  readonly configPath: string;
  readonly release: () => Promise<void>;
}

/** Host the workspace here: nothing persists, so no process is involved. */
async function serveInProcess(flags: Flags): Promise<Served> {
  const host = await hostWorkspace({
    artifacts: flags.artifacts,
    askable: false,
    dry: flags.dry,
    env: "require",
    only: flags.only,
    print,
    source: flags.config,
    state: flags.state,
  });
  return {
    attached: host,
    configPath: host.configPath,
    release: () => host.close(),
  };
}

/**
 * Attach the workspace to the Marbles process and answer from there. The
 * process keeps hosting it after this server closes; any other workspace
 * it hosts can be named by id, resolved through the last listing.
 */
async function serveFromProcess(flags: Flags): Promise<Served> {
  const client = await connect({
    layout: layout({ artifacts: flags.artifacts, state: flags.state }),
    only: flags.only,
  });
  const source = resolveSource(flags.config);
  let summary: WorkspaceSummary;
  try {
    summary = await client.attach(source, { root: process.cwd() });
  } catch (error) {
    client.close();
    throw error;
  }
  const known = new Map<string, WorkspaceSummary>([[summary.id, summary]]);
  const unsubscribe = client.subscribe(summary.id, { line: print });
  return {
    attached: client.workspace(summary),
    configPath: summary.config ?? source,
    release: () => {
      unsubscribe();
      client.close();
      return Promise.resolve();
    },
    workspace(id) {
      const found = known.get(id);
      if (found === undefined) {
        throw new Error(
          `no workspace "${id}" is hosted; list_workspaces names the hosted ones`
        );
      }
      return client.workspace(found);
    },
    async workspaces() {
      const summaries = await client.workspaces();
      for (const entry of summaries) {
        known.set(entry.id, entry);
      }
      return summaries;
    },
  };
}

const args = parseMcpArgs(process.argv.slice(2));
if (args.help) {
  print(
    "bun run src/mcp/stdio.ts [--source <file-or-directory>] [--state <directory>] [--artifacts <directory>] [--harness <id>] [--dry-run]"
  );
} else {
  const served = await (args.dry ? serveInProcess : serveFromProcess)(args);
  if (served.attached.config === null) {
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
