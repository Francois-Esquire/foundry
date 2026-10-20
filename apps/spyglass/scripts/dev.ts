import { resolve } from "node:path";
import { createServer } from "vite";
import { HELP, parseArguments, workspacesOf } from "../src/cli/args";
import { savedCollection } from "../src/lib/dataset-files";
import { type ScanProgressEvent, scan } from "../src/lib/scan";
import { DEFAULT_PORT } from "../src/lib/serve";
import { workspaceState } from "../src/lib/state";
import { startServer } from "../src/server/server";

// Defaults are independent of Turbo's package working directory.
const argv = process.argv.slice(2);
const packageMode = argv.includes("--package");
const args = parseArguments(
  argv.filter((arg) => arg !== "--package"),
  resolve(import.meta.dirname, packageMode ? ".." : "../../..")
);
if (args.command === "help") {
  process.stdout.write(
    `Spyglass development server: scans, then serves with hot reload. Defaults to Foundry; --package defaults to Spyglass itself. Pass a path to analyze another workspace or standalone package.\n\n${HELP}`
  );
} else if (args.command === "open") {
  const workspaces = await workspacesOf(args.paths);
  const options = {
    history: args.history,
    onProgress: args.quiet
      ? undefined
      : (event: ScanProgressEvent) => {
          if (event.kind === "phase") {
            process.stderr.write(
              `${event.phase}${event.detail ? `: ${event.detail}` : ""}\n`
            );
          }
        },
    state: args.state,
  };
  if ("root" in workspaces) {
    await scan(workspaces.root, options);
  } else {
    await scan.collection(workspaces.roots, {
      history: args.history,
      onProgress:
        options.onProgress === undefined
          ? undefined
          : ({ event }) => options.onProgress?.(event),
      state: args.state,
    });
  }
  const files =
    "root" in workspaces
      ? startServer({
          output: (await workspaceState(workspaces.root, args.state)).output,
          port: 0,
        })
      : startServer({
          collection: await savedCollection(workspaces.roots, args.state),
          port: 0,
        });
  try {
    const server = await createServer({
      configFile: resolve(import.meta.dirname, "../vite.config.ts"),
      server: {
        host: "127.0.0.1",
        open: !args["no-open"],
        port: args.port ?? DEFAULT_PORT,
        proxy: { "/data": files.url.href },
        strictPort: true,
      },
    });
    await server.listen();
    server.printUrls();
    // A signal handler replaces the default exit, so exit once both servers
    // close rather than wait on whatever handle the watcher leaves open.
    const stop = async () => {
      files.stop(true);
      await server.close();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    files.stop(true);
    throw error;
  }
} else {
  throw new Error(
    "Pass a workspace or package path to dev, not a CLI command. Prefix command-like directory names with ./."
  );
}
