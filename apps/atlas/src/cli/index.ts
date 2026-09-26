#!/usr/bin/env bun
import { resolve } from "node:path";
import { file } from "bun";
import { startServer } from "../server/server";
import { HELP, parseArguments } from "./args";
import { openBrowser } from "./browser";
import { scan } from "./scan";
import { resolveWorkspace } from "./workspace";

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  const workspace = await resolveWorkspace(args.target, args.state);
  if (args.command !== "serve") {
    await scan(workspace, args.history);
    process.stdout.write(`Output saved to ${workspace.output}\n`);
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
      "Atlas web assets are missing. Run bun run --filter @foundry/atlas build first."
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
