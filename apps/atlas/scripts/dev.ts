import { resolve } from "node:path";
import { createServer } from "vite";
import { HELP, parseArguments } from "../src/cli/args";
import { resolveWorkspace } from "../src/cli/workspace";
import { startServer } from "../src/server/server";

const args = parseArguments(process.argv.slice(2));
if (args.help) {
  process.stdout.write(
    `Atlas development viewer. Loads saved output without scanning.\n\n${HELP}`
  );
} else {
  const workspace = await resolveWorkspace(args.target, args.state);
  const files = startServer({ output: workspace.output, port: 0 });
  try {
    const server = await createServer({
      configFile: resolve(import.meta.dirname, "../vite.config.ts"),
      server: {
        host: "127.0.0.1",
        open: args.open,
        port: args.port,
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
