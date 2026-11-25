import {
  MAX_OPERATIONS_PER_CHANGE,
  taskChangeResultSchema,
  taskOperationSchema,
} from "@foundry/tasks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { answered } from "~/mcp/errors";
import {
  getInput,
  listInput,
  type McpServerOptions,
  resources,
  runItem,
  WORKSPACE_INPUT,
} from "~/mcp/resources";
import type { DispatchInfo, WorkspaceConnection } from "~/model/connection";
import { dispatchSchema } from "~/workspace/dispatch";
import { version } from "../../package.json";

const NEEDS_HOST =
  "Needs a running Marbles process that hosts the workspace (marbles daemon attach); this server starts none.";

const OFFLINE =
  "workspaces and tasks are read from stored state without a running Marbles process; definitions and runs need one.";

const listOutput = z.looseObject({
  items: z.array(z.record(z.string(), z.unknown())),
  nextCursor: z.int().min(0).optional(),
  total: z.int().min(0),
});

const getOutput = z.looseObject({
  item: z.record(z.string(), z.unknown()),
});

function launched({ runId, ...run }: DispatchInfo): Record<string, unknown> {
  return { id: runId, ...run };
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const on = <T>(
    id: string | undefined,
    work: (workspace: WorkspaceConnection) => Promise<T>
  ): Promise<T> => options.hosted(id ?? options.id, work);
  const read = resources(options);

  const server = new McpServer({ name: "marbles", version });
  server.registerTool(
    "list",
    {
      annotations: { readOnlyHint: true },
      description: `List one resource of a Marbles workspace: workspaces (every workspace the Marbles process hosts, or those kept under the state root, each stopped), definitions (launchable workflows and steps), tasks (oldest first; filter.ready true lists what is next), or runs (agent and workflow runs, newest first). filter takes only the keys its resource names; fields picks top-level fields and always keeps the identity field. Paginated: pass the returned nextCursor as cursor (runs cursors are offsets into the current newest-first list). A task's updatedAt is the expectedUpdatedAt token for change_tasks. ${OFFLINE} Refusals return {error: {code, message}}.`,
      inputSchema: listInput,
      outputSchema: listOutput,
    },
    (input) => answered(() => read.list(input))
  );
  server.registerTool(
    "get",
    {
      annotations: { readOnlyHint: true },
      description: `Read one resource by id: workspace (its summary, and when hosted and ready its definitions, agents, schedules, monitors and observers; id defaults to this server's workspace), definition (by name, with its input schema), task (with depth levels of subtasks; ask for dependsOn or dependents in fields to read its dependencies), or run (status, session, final text or output, error). fields picks top-level fields and always keeps the identity field. ${OFFLINE} Refusals return {error: {code, message}}.`,
      inputSchema: getInput,
      outputSchema: getOutput,
    },
    (input) => answered(() => read.get(input))
  );
  server.registerTool(
    "enqueue_workflow",
    {
      description: `Start a named Marbles workflow or step in the background and return its run id and status; schedule and monitor keys are not addressable. Passing the same name and key again in this workspace returns the run already queued under it instead of starting another. Read status and final output with get (resource: run), or follow it live with marbles watch <id>. list (resource: definitions) names what can start; read input schemas with get (resource: definition) or list (resource: definitions, fields: ["inputSchema"]). This can perform the actions defined by the source. ${NEEDS_HOST}`,
      inputSchema: {
        input: z.unknown().optional(),
        key: z
          .string()
          .min(1)
          .refine((value) => value.trim().length > 0, "key must not be blank")
          .optional(),
        name: z.string().min(1),
        workspace: WORKSPACE_INPUT,
      },
    },
    ({ input, key, name, workspace: id }) =>
      answered(async () =>
        launched(
          await on(id, (workspace) =>
            workspace.dispatchWorkflow(
              name,
              input,
              key === undefined ? undefined : { key }
            )
          )
        )
      )
  );
  server.registerTool(
    "dispatch_agent",
    {
      description: `Start an agent in the background and return its run id and session. Use an agent ID from get (resource: workspace, fields: ["agents"]), or omit agent for an ad hoc agent; pass the returned session to continue it. Read status and final text with get (resource: run), or follow it live with marbles watch <id>. ${NEEDS_HOST}`,
      inputSchema: { ...dispatchSchema.shape, workspace: WORKSPACE_INPUT },
    },
    ({ workspace: id, ...dispatch }) =>
      answered(async () =>
        launched(await on(id, (workspace) => workspace.dispatchAgent(dispatch)))
      )
  );
  server.registerTool(
    "cancel_run",
    {
      description: `Cancel an agent or workflow run by id and return the run as get (resource: run) reads it. Read it again with get until cancellation finishes. ${NEEDS_HOST}`,
      inputSchema: { id: z.string().min(1), workspace: WORKSPACE_INPUT },
    },
    ({ id: runId, workspace: id }) =>
      answered(async () =>
        runItem(await on(id, (workspace) => workspace.cancelRun(runId)))
      )
  );
  server.registerTool(
    "change_tasks",
    {
      annotations: { destructiveHint: false, readOnlyHint: false },
      description:
        "Apply one atomic batch of task operations: task.create (key, input, optional parent), task.update (a patch: title, description and tags replace what is stored; metadata sets each key given and a null value removes it), task.set_status (open, active, completed, cancelled; requireReady refuses with not_ready unless the task is ready as the batch stands at that operation; later operations in the batch are not rechecked), task.move (parent null for root), dependency.add, dependency.remove. Refer to existing tasks by {id} and to tasks created earlier in the batch by {key}. Pass expectedUpdatedAt to refuse a change if the task moved on. Every operation applies or none does; a refusal returns {error: {code, message}}.",
      inputSchema: z.strictObject({
        operations: z
          .array(taskOperationSchema)
          .min(1)
          .max(MAX_OPERATIONS_PER_CHANGE),
        workspace: WORKSPACE_INPUT,
      }),
      outputSchema: taskChangeResultSchema,
    },
    ({ workspace, ...change }) =>
      answered(async () => ({
        ...(await options.tasks(
          { change, kind: "change" },
          workspace ?? options.id
        )),
      }))
  );
  return server;
}
