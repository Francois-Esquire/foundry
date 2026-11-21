import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { serve } from "bun";
import { z } from "zod";

export const backlog = {
  description: "The harness's own to-do list, served from this process.",
  name: "backlog",
  tools: [
    {
      description:
        "Add one follow-up to-do to the end of the list. Use it only for necessary work the list does not cover.",
      name: "add_todo",
    },
  ],
} as const;

export function serveBacklog(add: (title: string) => Promise<string>) {
  const [tool] = backlog.tools;
  const server = serve({
    fetch: async (request) => {
      const mcp = new McpServer({ name: backlog.name, version: "0.0.0" });
      mcp.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: { title: z.string().min(1).max(80) },
        },
        async ({ title }) => ({
          content: [{ text: await add(title), type: "text" }],
        })
      );
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await mcp.connect(transport);
      return transport.handleRequest(request);
    },
    hostname: "127.0.0.1",
    idleTimeout: 0,
    port: 0,
  });
  return {
    stop: () => server.stop(true),
    url: `http://127.0.0.1:${server.port}/mcp`,
  };
}
