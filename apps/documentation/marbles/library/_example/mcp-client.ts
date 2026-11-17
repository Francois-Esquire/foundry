import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

export interface McpCountOptions {
  readonly home?: string;
  /** The `count` module, or the project's `.foundry/marbles` folder. */
  readonly source: string;
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
  const args = ["mcp", "--source", options.source];
  const env =
    options.home === undefined
      ? undefined
      : {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined
            )
          ),
          FOUNDRY_HOME: options.home,
        };
  const client = new Client({ name: "count-example", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      args,
      command: "marbles",
      ...(env === undefined ? {} : { env }),
    })
  );
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
