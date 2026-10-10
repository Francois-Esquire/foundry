#!/usr/bin/env bun
import { resolve } from "node:path";
import { file } from "bun";
import type { ScanProgressEvent } from "../lib/scan";
import { scan } from "../lib/scan";
import { workspaceState } from "../lib/state";
import { startServer } from "../server/server";
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

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  const workspace = await workspaceState(args.target, args.state);
  if (args.command !== "serve") {
    const result = await scan(workspace.root, {
      history: args.history,
      onProgress: printProgress,
      state: args.state,
    });
    process.stdout.write(`Output saved to ${result.output}\n`);
  }
  if (args.command === "scan") {
    return;
  }
  // Build preserves this relative location; source execution has a different base.
  const webRoot = resolve(
    import.meta.dirname,
    import.meta.main && import.meta.file === "atlas.js"
      ? "../web"
      : "../../dist/web"
  );
  if (!(await file(resolve(webRoot, "index.html")).exists())) {
    throw new Error(
      `Web assets are missing from ${webRoot}. Reinstall the package, or build it first when running from source.`
    );
  }
  const server = startServer({
    output: workspace.output,
    port: args.port,
    webRoot,
  });
  const url = server.url.href;
  process.stdout.write(`Atlas: ${url}\nWorkspace: ${workspace.root}\n`);
  const stop = () => {
    server.stop(true);
  };
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
