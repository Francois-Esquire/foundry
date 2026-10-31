#!/usr/bin/env bun
import { Console } from "node:console";
import { Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseMcpArgs } from "~/args";
import { catalog } from "~/authoring/catalog";
import { hostEngine, openWorkspace, touchWorkspace } from "~/host";
import { createMcpServer } from "~/mcp/server";
import { resolveSource } from "~/source";

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

/** Load the source, start the engine, and serve until the client leaves. */
async function serve(flags: ReturnType<typeof parseMcpArgs>): Promise<void> {
  const configPath = resolveSource(flags.config);
  const opened = await openWorkspace(flags, { env: "require", print }).catch(
    (error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `could not open the workspace for "${configPath}": ${reason}`,
        { cause: error }
      );
    }
  );
  if (opened.config === null) {
    throw new Error(`no Marbles source at "${opened.configPath}"`);
  }
  const engine = await hostEngine(flags, opened, { askable: false, print });
  const server = createMcpServer(engine, catalog, opened);
  const close = async (): Promise<void> => {
    try {
      await server.close();
    } finally {
      await engine.dispose();
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
    await engine.start();
    touchWorkspace(engine, opened);
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

let args: ReturnType<typeof parseMcpArgs> | undefined;
try {
  args = parseMcpArgs(process.argv.slice(2));
} catch (error) {
  report(error);
}
if (args?.help) {
  print(
    "bun run src/mcp/stdio.ts [--source <file-or-directory>] [--state <directory>] [--artifacts <directory>] [--harness <id>] [--dry-run]"
  );
} else if (args !== undefined) {
  await serve(args).catch(report);
}
