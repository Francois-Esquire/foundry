import { resolve } from "node:path";
import { createServer } from "vite";
import { HELP, parseArguments } from "../src/cli/args";
import { DEFAULT_PORT } from "../src/lib/serve";
import { workspaceState } from "../src/lib/state";
import { startServer } from "../src/server/server";

// Read as `atlas serve`: a path, --state, --port, and --no-open.
const args = parseArguments(["serve", ...process.argv.slice(2)]);
if (args.command === "help") {
  process.stdout.write(
    `Atlas development server, read as atlas serve: serves the saved dataset without scanning.\n\n${HELP}`
  );
} else if (args.command === "serve") {
  const [root] = args.paths;
  const workspace = await workspaceState(root, args.state);
  const files = startServer({ output: workspace.output, port: 0 });
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
    const stop = async () => {
      files.stop(true);
      await server.close();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    files.stop(true);
    throw error;
  }
}
