import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { WorkspaceConnection } from "~/model/connection";
import { dispatchSchema } from "~/workspace/dispatch";
import { version } from "../../package.json";

function result(value: unknown): CallToolResult {
  return {
    content: [{ text: JSON.stringify(value ?? null), type: "text" }],
  };
}

/** One connection over one workspace, wherever its engine runs. */
export function createMcpServer(workspace: WorkspaceConnection): McpServer {
  const server = new McpServer({ name: "marbles", version });
  server.registerTool(
    "list_config",
    {
      annotations: { readOnlyHint: true },
      description:
        "List the loaded Marbles source, launchable definitions with input schemas, agents, and declared triggers.",
    },
    async () => result(await workspace.describe())
  );
  server.registerTool(
    "dispatch_workflow",
    {
      description:
        "Start a named Marbles workflow or step in the background and return its runId. Final output is available through get_run. Use marbles watch <runId> to follow output until completion. Use list_config for names and input schemas. This can perform the actions defined by the source.",
      inputSchema: { input: z.unknown().optional(), name: z.string().min(1) },
    },
    async ({ name, input }) =>
      result(await workspace.dispatchWorkflow(name, input))
  );
  server.registerTool(
    "dispatch_agent",
    {
      description:
        "Start an agent in the background and return its runId and session. Final output is available through get_run. Use an agent ID from list_config, or omit agent for an ad hoc agent. Use marbles watch <runId> to follow output until completion, or get_run to read status. The server must remain running.",
      inputSchema: dispatchSchema.shape,
    },
    async (options) => result(await workspace.dispatchAgent(options))
  );
  server.registerTool(
    "get_run",
    {
      annotations: { readOnlyHint: true },
      description:
        "Read an agent or workflow run's status, session, final text/output, or error by runId.",
      inputSchema: { runId: z.string().min(1) },
    },
    async ({ runId }) => result(await workspace.getRun(runId))
  );
  server.registerTool(
    "cancel_run",
    {
      description:
        "Cancel an agent or workflow run. Poll get_run until cancellation finishes.",
      inputSchema: { runId: z.string().min(1) },
    },
    async ({ runId }) => result(await workspace.cancelRun(runId))
  );
  return server;
}
