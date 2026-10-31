import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Catalog } from "~/authoring/catalog";
import type { OpenedWorkspace } from "~/host";
import { hostTasks } from "~/host";
import type { Engine } from "~/lib/engine";
import { BackgroundRuns } from "~/mcp/background-runs";
import { dispatchSchema } from "~/mcp/dispatch";
import { registerTaskTools } from "~/mcp/tasks";
import { version } from "../../package.json";

function result(value: unknown): CallToolResult {
  return {
    content: [{ text: JSON.stringify(value ?? null), type: "text" }],
  };
}

/** One connection over one loaded workspace, its engine, and its backlog. */
export function createMcpServer(
  engine: Engine,
  catalog: Catalog,
  opened: OpenedWorkspace
): McpServer {
  const server = new McpServer({ name: "marbles", version });
  const dispatches = new BackgroundRuns(engine, catalog);
  server.server.onclose = async () => {
    await dispatches.close();
  };
  server.registerTool(
    "list_config",
    {
      annotations: { readOnlyHint: true },
      description:
        "List the loaded Marbles source, launchable definitions with input schemas, agents, and declared triggers.",
    },
    () =>
      result({
        agents: [...catalog.agents.values()].map(({ id, model, provider }) => ({
          id,
          model,
          provider,
        })),
        definitions: dispatches.definitions(),
        monitors: [...catalog.monitors.values()].map(
          ({ key, label, source, trigger }) => ({
            key,
            label,
            source,
            trigger,
          })
        ),
        root: opened.workspace.root,
        schedules: [...catalog.schedules.values()],
        source: opened.config,
      })
  );
  server.registerTool(
    "dispatch_workflow",
    {
      description:
        "Start a named Marbles workflow or step in the background and return its runId. Final output is available through get_run. Use marbles watch <runId> to follow output until completion. Use list_config for names and input schemas. This can perform the actions defined by the source.",
      inputSchema: { input: z.unknown().optional(), name: z.string().min(1) },
    },
    async ({ name, input }) =>
      result(await dispatches.startWorkflow(name, input))
  );
  server.registerTool(
    "dispatch_agent",
    {
      description:
        "Start an agent in the background and return its runId and session. Final output is available through get_run. Use an agent ID from list_config, or omit agent for an ad hoc agent. Use marbles watch <runId> to follow output until completion, or get_run to read status. The server must remain running.",
      inputSchema: dispatchSchema.shape,
    },
    async (options) => result(await dispatches.start(options))
  );
  server.registerTool(
    "get_run",
    {
      annotations: { readOnlyHint: true },
      description:
        "Read an agent or workflow run's status, session, final text/output, or error by runId.",
      inputSchema: { runId: z.string().min(1) },
    },
    async ({ runId }) => result(await dispatches.get(runId))
  );
  server.registerTool(
    "cancel_run",
    {
      description:
        "Cancel an agent or workflow run. Poll get_run until cancellation finishes.",
      inputSchema: { runId: z.string().min(1) },
    },
    async ({ runId }) => result(await dispatches.cancel(runId))
  );
  registerTaskTools(server, hostTasks(engine));
  return server;
}
