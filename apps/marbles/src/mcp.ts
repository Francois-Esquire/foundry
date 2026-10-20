#!/usr/bin/env bun
import { Console } from "node:console";
import { Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseArgs } from "~/args";
import { catalog } from "~/authoring/catalog";
import { hostEngine, openWorkspace, touchWorkspace } from "~/host";
import { createMcpServer } from "~/mcp/server";

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

const args = parseArgs(["list", ...process.argv.slice(2)]);
if (args.command === "help") {
  print(
    "bun run src/mcp.ts [--source <file-or-directory>] [--state <directory>] [--artifacts <directory>] [--harness <id>] [--dry-run]"
  );
} else {
  const opened = await openWorkspace(args, { env: "require", print });
  if (opened.config === null) {
    throw new Error(`no Marbles source at "${opened.configPath}"`);
  }
  const engine = hostEngine(args, opened, { askable: false, print });
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
