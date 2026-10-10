#!/usr/bin/env bun
import type { ScanProgressEvent } from "../lib/scan";
import { scan } from "../lib/scan";
import { serve, viewerRoot } from "../lib/serve";
import type { Arguments } from "./args";
import { HELP, parseArguments } from "./args";
import { openBrowser } from "./browser";

/** Phases, then one line per package's internals; the rest is for programs. */
function printProgress(event: ScanProgressEvent) {
  if (event.kind === "phase") {
    process.stderr.write(
      `${event.phase}${event.detail ? `: ${event.detail}` : ""}\n`
    );
  } else if (event.kind === "internals") {
    process.stderr.write(`internals: ${event.package}\n`);
  }
}

async function scanWorkspace(args: Arguments) {
  const result = await scan(args.target, {
    history: args.history,
    onProgress: printProgress,
    state: args.state,
  });
  process.stdout.write(`Output saved to ${result.output}\n`);
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.command === "scan") {
    await scanWorkspace(args);
    return;
  }
  if (args.command === "open") {
    // Fail before the scan, not after it, when there is no viewer to open.
    await viewerRoot();
    await scanWorkspace(args);
  }
  const server = await serve(args.target, {
    port: args.port,
    state: args.state,
  });
  const url = server.url.href;
  process.stdout.write(`Atlas: ${url}\nWorkspace: ${server.root}\n`);
  const stop = () => server.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (args.open) {
    try {
      await openBrowser(url);
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)} Open ${url}\n`
      );
    }
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `Atlas: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}
