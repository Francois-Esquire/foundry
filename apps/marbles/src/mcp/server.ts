import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { registerTaskTools } from "~/mcp/tasks";
import type { WorkspaceConnection, WorkspaceSummary } from "~/model/connection";
import { dispatchSchema } from "~/workspace/dispatch";
import { version } from "../../package.json";

/**
 * What one MCP server answers for. The attached workspace is the default
 * for every tool; with a Marbles process behind the server, any workspace
 * it hosts can be named instead. Without one (`--dry-run` hosts a single
 * workspace in-process) only the attached workspace exists.
 */
export interface McpServerOptions {
  /** The workspace a tool call addresses when it names none. */
  readonly attached: WorkspaceConnection;
  /** A hosted workspace by id; absent without a Marbles process. */
  readonly workspace?: (id: string) => WorkspaceConnection;
  /** Every workspace the Marbles process hosts; absent without one. */
  readonly workspaces?: () => Promise<readonly WorkspaceSummary[]>;
}

function result(value: unknown): CallToolResult {
  return {
    content: [{ text: JSON.stringify(value ?? null), type: "text" }],
  };
}

const WORKSPACE_INPUT = z
  .string()
  .min(1)
  .optional()
  .describe(
    "A workspace id from list_workspaces; the attached workspace when omitted."
  );

/**
 * One server over every workspace the process hosts, the attached one by
 * default: its runs, and its backlog through the same task commands as
 * `marbles tasks`.
 */
export function createMcpServer(options: McpServerOptions): McpServer {
  const { attached, workspace, workspaces } = options;

  /** The connection a tool call addresses. */
  const pick = async (id?: string): Promise<WorkspaceConnection> => {
    if (id === undefined || id === attached.id) {
      return attached;
    }
    if (workspace === undefined || workspaces === undefined) {
      throw new Error(
        `only the attached workspace "${attached.id}" is available without a Marbles process`
      );
    }
    // The listing is what tells the client which ids are hosted now.
    await workspaces();
    return workspace(id);
  };

  const server = new McpServer({ name: "marbles", version });
  server.registerTool(
    "list_workspaces",
    {
      annotations: { readOnlyHint: true },
      description:
        "List every workspace the Marbles process hosts, with its id, root, source, and state. Pass an id as `workspace` to another tool to address it instead of the attached one.",
    },
    async () =>
      result(
        workspaces === undefined
          ? [
              {
                config: attached.config,
                id: attached.id,
                root: attached.root,
                state: "ready",
              } satisfies WorkspaceSummary,
            ]
          : await workspaces()
      )
  );
  server.registerTool(
    "list_config",
    {
      annotations: { readOnlyHint: true },
      description:
        "List the loaded Marbles source, launchable definitions with input schemas, agents, and declared triggers.",
      inputSchema: { workspace: WORKSPACE_INPUT },
    },
    async ({ workspace: id }) => result(await (await pick(id)).describe())
  );
  server.registerTool(
    "dispatch_workflow",
    {
      description:
        "Start a named Marbles workflow or step in the background and return its runId. Final output is available through get_run. Use marbles watch <runId> to follow output until completion. Use list_config for names and input schemas. This can perform the actions defined by the source.",
      inputSchema: {
        input: z.unknown().optional(),
        name: z.string().min(1),
        workspace: WORKSPACE_INPUT,
      },
    },
    async ({ name, input, workspace: id }) =>
      result(await (await pick(id)).dispatchWorkflow(name, input))
  );
  server.registerTool(
    "dispatch_agent",
    {
      description:
        "Start an agent in the background and return its runId and session. Final output is available through get_run. Use an agent ID from list_config, or omit agent for an ad hoc agent. Use marbles watch <runId> to follow output until completion, or get_run to read status.",
      inputSchema: { ...dispatchSchema.shape, workspace: WORKSPACE_INPUT },
    },
    async ({ workspace: id, ...dispatch }) =>
      result(await (await pick(id)).dispatchAgent(dispatch))
  );
  server.registerTool(
    "get_run",
    {
      annotations: { readOnlyHint: true },
      description:
        "Read an agent or workflow run's status, session, final text/output, or error by runId.",
      inputSchema: { runId: z.string().min(1), workspace: WORKSPACE_INPUT },
    },
    async ({ runId, workspace: id }) =>
      result(await (await pick(id)).getRun(runId))
  );
  server.registerTool(
    "cancel_run",
    {
      description:
        "Cancel an agent or workflow run. Poll get_run until cancellation finishes.",
      inputSchema: { runId: z.string().min(1), workspace: WORKSPACE_INPUT },
    },
    async ({ runId, workspace: id }) =>
      result(await (await pick(id)).cancelRun(runId))
  );
  registerTaskTools(
    server,
    async (command, id) => (await pick(id)).tasks(command),
    WORKSPACE_INPUT
  );
  return server;
}
