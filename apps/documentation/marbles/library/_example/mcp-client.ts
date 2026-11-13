import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

export interface McpCountOptions {
  /** `apps/marbles/src/mcp/stdio.ts` in a Foundry checkout. */
  readonly server: string;
  /** The `count` module, or the project's `.foundry/marbles` folder. */
  readonly source: string;
  /** A state root; omit it to use `~/.foundry/marbles`. */
  readonly state?: string;
}

const POLL_MS = 250;

/** Marbles tools answer with JSON in one text block. */
function json(result: unknown): Record<string, unknown> {
  const [block] = CallToolResultSchema.parse(result).content;
  if (block?.type !== "text") {
    throw new Error("The tool answered without text.");
  }
  return JSON.parse(block.text);
}

/**
 * Starts `count` through the Marbles MCP server and reads it back by run ID,
 * as an external agent would. Dispatch only acknowledges the run, so the
 * client asks `get_run` until the run is no longer queued or running.
 */
export async function countOverMcp(
  options: McpCountOptions
): Promise<Record<string, unknown>> {
  const args = [options.server, "--source", options.source];
  if (options.state !== undefined) {
    args.push("--state", options.state);
  }
  const client = new Client({ name: "count-example", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ args, command: "bun" }));
  try {
    const { runId } = json(
      await client.callTool({
        arguments: { input: { extension: ".ts" }, name: "count" },
        name: "dispatch_workflow",
      })
    );
    const deadline = Date.now() + 30_000;
    for (;;) {
      const run = json(
        await client.callTool({ arguments: { runId }, name: "get_run" })
      );
      if (run.status !== "queued" && run.status !== "running") {
        return run;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Run ${String(runId)} did not settle within the polling window.`
        );
      }
      await sleep(POLL_MS);
    }
  } finally {
    await client.close();
  }
}
