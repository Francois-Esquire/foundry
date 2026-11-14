import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { registerTaskTools, type TaskCommandRunner } from "~/mcp/tasks";
import type { WorkspaceConnection, WorkspaceSummary } from "~/model/connection";
import { dispatchSchema } from "~/workspace/dispatch";
import { version } from "../../package.json";

/**
 * What one MCP server answers for. Tool calls address the server's own
 * workspace unless they name another by id. The server manages nothing:
 * each operation reads stored state or asks a running instance.
 */
export interface McpServerOptions {
  /**
   * Run `work` against the running instance that hosts workspace `id`.
   * Rejects, naming the command that hosts it, when none does.
   */
  hosted<T>(
    id: string,
    work: (workspace: WorkspaceConnection) => Promise<T>
  ): Promise<T>;
  /** The workspace a tool call addresses when it names none. */
  readonly id: string;
  /** One task command on a workspace, with or without a running instance. */
  readonly tasks: TaskCommandRunner;
  /** The workspaces a tool call can name. */
  workspaces(): Promise<readonly WorkspaceSummary[]>;
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
    "A workspace id from list_workspaces; this server's workspace when omitted."
  );

const NEEDS_HOST =
  "Needs a running Marbles process that hosts the workspace (marbles attach); this server starts none.";

/**
 * One server over this workspace, and any other a running Marbles process
 * hosts: its runs, and its backlog through the same task commands as
 * `marbles tasks`.
 */
export function createMcpServer(options: McpServerOptions): McpServer {
  const { hosted, tasks, workspaces } = options;
  const on = <T>(
    id: string | undefined,
    work: (workspace: WorkspaceConnection) => Promise<T>
  ): Promise<T> => hosted(id ?? options.id, work);

  const server = new McpServer({ name: "marbles", version });
  server.registerTool(
    "list_workspaces",
    {
      annotations: { readOnlyHint: true },
      description:
        "List every workspace the Marbles process hosts, with its id, root, source, and state; without a running process, the workspaces kept under the state root, each stopped. Pass an id as `workspace` to another tool to address it instead of this server's own.",
    },
    async () => result(await workspaces())
  );
  server.registerTool(
    "list_config",
    {
      annotations: { readOnlyHint: true },
      description: `List the loaded Marbles source, launchable definitions with input schemas, agents, and declared triggers. ${NEEDS_HOST}`,
      inputSchema: { workspace: WORKSPACE_INPUT },
    },
    async ({ workspace: id }) =>
      result(await on(id, (workspace) => workspace.describe()))
  );
  server.registerTool(
    "dispatch_workflow",
    {
      description: `Start a named Marbles workflow or step in the background and return its runId. Final output is available through get_run. Use marbles watch <runId> to follow output until completion. Use list_config for names and input schemas. This can perform the actions defined by the source. ${NEEDS_HOST}`,
      inputSchema: {
        input: z.unknown().optional(),
        name: z.string().min(1),
        workspace: WORKSPACE_INPUT,
      },
    },
    async ({ name, input, workspace: id }) =>
      result(
        await on(id, (workspace) => workspace.dispatchWorkflow(name, input))
      )
  );
  server.registerTool(
    "dispatch_agent",
    {
      description: `Start an agent in the background and return its runId and session. Final output is available through get_run. Use an agent ID from list_config, or omit agent for an ad hoc agent. Use marbles watch <runId> to follow output until completion, or get_run to read status. ${NEEDS_HOST}`,
      inputSchema: { ...dispatchSchema.shape, workspace: WORKSPACE_INPUT },
    },
    async ({ workspace: id, ...dispatch }) =>
      result(await on(id, (workspace) => workspace.dispatchAgent(dispatch)))
  );
  server.registerTool(
    "get_run",
    {
      annotations: { readOnlyHint: true },
      description: `Read an agent or workflow run's status, session, final text/output, or error by runId. ${NEEDS_HOST}`,
      inputSchema: { runId: z.string().min(1), workspace: WORKSPACE_INPUT },
    },
    async ({ runId, workspace: id }) =>
      result(await on(id, (workspace) => workspace.getRun(runId)))
  );
  server.registerTool(
    "cancel_run",
    {
      description: `Cancel an agent or workflow run. Poll get_run until cancellation finishes. ${NEEDS_HOST}`,
      inputSchema: { runId: z.string().min(1), workspace: WORKSPACE_INPUT },
    },
    async ({ runId, workspace: id }) =>
      result(await on(id, (workspace) => workspace.cancelRun(runId)))
  );
  registerTaskTools(
    server,
    (command, id) => tasks(command, id ?? options.id),
    WORKSPACE_INPUT
  );
  return server;
}
