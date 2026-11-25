import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

export interface McpCountOptions {
  readonly home?: string;
  readonly source: string;
}

const POLL_MS = 250;

function json(result: unknown): Record<string, unknown> {
  const [block] = CallToolResultSchema.parse(result).content;
  if (block?.type !== "text") {
    throw new Error("The tool answered without text.");
  }
  return JSON.parse(block.text);
}

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
    const { id } = json(
      await client.callTool({
        arguments: { input: { extension: ".ts" }, name: "count" },
        name: "enqueue_workflow",
      })
    );
    const deadline = Date.now() + 30_000;
    for (;;) {
      const { item: run } = json(
        await client.callTool({
          arguments: { id, resource: "run" },
          name: "get",
        })
      ) as { readonly item: Record<string, unknown> };
      if (run.status !== "queued" && run.status !== "running") {
        return run;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Run ${String(id)} did not settle within the polling window.`
        );
      }
      await sleep(POLL_MS);
    }
  } finally {
    await client.close();
  }
}
