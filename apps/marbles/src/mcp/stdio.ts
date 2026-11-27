import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { GlobalFlags } from "~/cli/context";
import { onRelayGone, protocolOutput, SHUTDOWN_GRACE_MS } from "~/mcp/relay";
import { createMcpServer } from "~/mcp/server";
import { createLocalMcpService } from "~/service/local";

const print = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

async function serve(flags: GlobalFlags): Promise<void> {
  const output = protocolOutput();
  const served = await createLocalMcpService(flags);
  const server = createMcpServer(served.mcpOptions);
  const close = async (): Promise<void> => {
    try {
      await server.close();
    } finally {
      await served.release();
    }
  };
  let closing = false;
  const shutdown = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    setTimeout(() => {
      print(
        `marbles mcp: shutdown did not finish within ${SHUTDOWN_GRACE_MS}ms; exiting`
      );
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
    close()
      .catch((error: unknown) => {
        print(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      })
      .finally(() => {
        output.end(() => process.exit());
      });
  };
  output.on("error", (error: Error) => {
    print(`marbles mcp: the protocol output failed: ${error.message}`);
    shutdown();
  });
  process.on("SIGHUP", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.once("end", shutdown);
  try {
    await server.connect(new StdioServerTransport(process.stdin, output));
  } catch (error) {
    await close();
    throw error;
  }
  onRelayGone(shutdown);
}

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

export async function serveStdio(flags: GlobalFlags): Promise<void> {
  await serve(flags).catch(report);
}
