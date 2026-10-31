/**
 * A stdio MCP server with one tool, `echo`, for tests that connect an
 * agent's MCP servers for real. Run by node as a subprocess, never imported.
 * An optional first argument delays the connection by that many
 * milliseconds, so a test can act while the client is still initializing.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fixture", version: "1.0.0" });
server.registerTool(
  "echo",
  {
    description: "Returns the text it is given",
    inputSchema: { text: z.string() },
  },
  ({ text }) => ({ content: [{ text, type: "text" }] })
);
const delayMs = Number(process.argv[2] ?? 0);
if (delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
await server.connect(new StdioServerTransport());
