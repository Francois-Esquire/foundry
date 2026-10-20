import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Catalog } from "~/authoring/catalog";
import type { OpenedWorkspace } from "~/host";
import type { Engine } from "~/lib/engine";
import { BackgroundRuns } from "~/runs";

function result(value: unknown): CallToolResult {
  return {
    content: [{ text: JSON.stringify(value ?? null), type: "text" }],
  };
}

/** One connection over one loaded workspace and its engine. */
export function createMcpServer(
  engine: Engine,
  catalog: Catalog,
  opened: OpenedWorkspace
): McpServer {
  const server = new McpServer({ name: "marbles", version: "0.0.1" });
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
        definitions: engine.definitions(),
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
        "Start a named Marbles workflow or step in the background and return its runId. Use marbles watch <runId> to follow output until completion. Use list_config for names and input schemas. This can perform the actions defined by the source.",
      inputSchema: { input: z.unknown().optional(), name: z.string().min(1) },
    },
    async ({ name, input }) =>
      result(await dispatches.startWorkflow(name, input))
  );
  server.registerTool(
    "dispatch_agent",
    {
      description:
        "Start an agent in the background and return its runId and session. Use an agent ID from list_config, or omit agent for an ad hoc agent. Use marbles watch <runId> to follow output until completion, or get_run to read status. The server must remain running.",
      inputSchema: {
        agent: z.string().trim().min(1).optional(),
        compaction: z.boolean().optional(),
        cwd: z.string().min(1).optional(),
        instructions: z.string().trim().min(1).optional(),
        maxTurns: z
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER)
          .optional()
          .describe(
            "Maximum model/tool steps, not a target. Supported by network models and local Claude Code, not local Codex/Pi."
          ),
        model: z.string().min(1).optional(),
        prompt: z.string().trim().min(1),
        provider: z.string().min(1).optional(),
        session: z
          .object({
            id: z.string().min(1),
            model: z.string().optional(),
            provider: z.string().optional(),
          })
          .optional(),
        timeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
      },
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
    ({ runId }) => result(dispatches.get(runId))
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
  return server;
}
