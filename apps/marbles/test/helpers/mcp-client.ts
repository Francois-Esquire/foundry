import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect } from "vitest";
import { z } from "zod";
import { NotHostedError } from "~/access/workspace";
import type { McpServerOptions } from "~/mcp/resources";
import { createMcpServer } from "~/mcp/server";

export type ToolResult = z.infer<typeof CallToolResultSchema>;

export interface Connected {
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  readonly client: Client;
  close(): Promise<void>;
}

function unhosted(id: string): Promise<never> {
  return Promise.reject(
    new NotHostedError(`nothing hosts workspace ${id} in this test`)
  );
}

export async function connectMcp(
  options: Partial<McpServerOptions>
): Promise<Connected> {
  const server = createMcpServer({
    hosted: (id) => unhosted(id),
    id: "own",
    tasks: () => Promise.reject(new Error("no tasks in this test")),
    workspaces: () => Promise.resolve([]),
    ...options,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "marbles-test", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    call: async (name, args = {}) =>
      CallToolResultSchema.parse(
        await client.callTool({ arguments: args, name })
      ),
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

export function textOf(result: ToolResult): string {
  const [block] = result.content;
  if (block?.type !== "text") {
    throw new Error("the result carried no text");
  }
  return block.text;
}

const refusal = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string() }),
});

export function refused(result: ToolResult): {
  readonly code: string;
  readonly message: string;
} {
  expect(result.isError, textOf(result)).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  return refusal.parse(JSON.parse(textOf(result))).error;
}

export function structured(result: ToolResult): Record<string, unknown> {
  expect(result.isError, textOf(result)).not.toBe(true);
  expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
  return result.structuredContent ?? {};
}
