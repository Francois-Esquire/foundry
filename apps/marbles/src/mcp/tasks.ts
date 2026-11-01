import {
  depthOptionsSchema,
  MAX_OPERATIONS_PER_CHANGE,
  readyQuerySchema,
  TaskError,
  taskChangeResultSchema,
  taskNodeSchema,
  taskOperationSchema,
  taskPageSchema,
  taskQuerySchema,
  taskRelationsSchema,
} from "@foundry/tasks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type {
  TaskCommand,
  TaskCommandKind,
  TaskCommandResult,
} from "~/model/tasks";
import { taskRefusal } from "~/workspace/tasks";

/**
 * Runs one command on the workspace a tool call names, the attached one
 * when it names none; a refusal rejects with the package's `TaskError`.
 */
export type TaskCommandRunner = <K extends TaskCommandKind>(
  command: TaskCommand<K>,
  workspace: string | undefined
) => Promise<TaskCommandResult<K>>;

/**
 * Runs one command and answers with its result as structured content, which
 * the server checks against the tool's output schema. A refusal from the
 * package is a tool error carrying `{ error: { code, message } }` as text.
 */
async function answer<K extends TaskCommandKind>(
  run: TaskCommandRunner,
  workspace: string | undefined,
  command: TaskCommand<K>,
  shape: (result: TaskCommandResult<K>) => Record<string, unknown>
): Promise<CallToolResult> {
  try {
    const structured = shape(await run(command, workspace));
    return {
      content: [{ text: JSON.stringify(structured), type: "text" }],
      structuredContent: structured,
    };
  } catch (error) {
    if (!(error instanceof TaskError)) {
      throw error;
    }
    return {
      content: [
        {
          text: JSON.stringify({ error: taskRefusal(error) }),
          type: "text",
        },
      ],
      isError: true,
    };
  }
}

/** A result that is already an object is the structured content itself. */
const asIs = (result: object): Record<string, unknown> => ({ ...result });

const idInput = z.string().min(1);

/**
 * The workspace backlog as MCP tools: the same commands, input schemas, and
 * refusals as `marbles tasks`, each beside the `workspace` input every
 * Marbles tool takes. Reads change nothing; `change_tasks` takes one atomic
 * batch in the task command language.
 */
export function registerTaskTools(
  server: McpServer,
  run: TaskCommandRunner,
  workspaceInput: z.ZodOptional<z.ZodString>
): void {
  const addressed = { workspace: workspaceInput };
  // `taskChangeSchema` is typed as a plain schema, so its one field is
  // spelled here to sit beside `workspace`; the bounds are the package's.
  const changeInput = z.strictObject({
    operations: z
      .array(taskOperationSchema)
      .min(1)
      .max(MAX_OPERATIONS_PER_CHANGE),
    ...addressed,
  });
  server.registerTool(
    "list_tasks",
    {
      annotations: { readOnlyHint: true },
      description:
        "List this workspace's tasks, oldest first, optionally by status or parent (parentId null for root tasks). depth expands subtasks. Paginated: pass the returned nextCursor as cursor; limit is capped by the backlog.",
      inputSchema: taskQuerySchema.extend(addressed),
      outputSchema: taskPageSchema,
    },
    ({ workspace, ...query }) =>
      answer(run, workspace, { kind: "list", query }, asIs)
  );
  server.registerTool(
    "ready_tasks",
    {
      annotations: { readOnlyHint: true },
      description:
        "List open tasks nothing holds back, oldest first: what is next. Paginated like list_tasks.",
      inputSchema: readyQuerySchema.extend(addressed),
      outputSchema: taskPageSchema,
    },
    ({ workspace, ...query }) =>
      answer(run, workspace, { kind: "ready", query }, asIs)
  );
  server.registerTool(
    "get_task",
    {
      annotations: { readOnlyHint: true },
      description:
        "Read one task by id, with depth levels of subtasks. Its updatedAt is the expectedUpdatedAt token for a change that must not overwrite a newer one.",
      inputSchema: depthOptionsSchema.extend({ id: idInput, ...addressed }),
      outputSchema: z.strictObject({ task: taskNodeSchema }),
    },
    ({ depth, id, workspace }) =>
      answer(
        run,
        workspace,
        { id, kind: "get", ...(depth === undefined ? {} : { depth }) },
        (task) => ({ task })
      )
  );
  server.registerTool(
    "task_dependencies",
    {
      annotations: { readOnlyHint: true },
      description:
        "Read the tasks one task depends on and the tasks that depend on it.",
      inputSchema: z.strictObject({ id: idInput, ...addressed }),
      outputSchema: taskRelationsSchema,
    },
    ({ id, workspace }) =>
      answer(run, workspace, { id, kind: "dependencies" }, asIs)
  );
  server.registerTool(
    "change_tasks",
    {
      annotations: { destructiveHint: false, readOnlyHint: false },
      description:
        "Apply one atomic batch of task operations: task.create (key, input, optional parent), task.update, task.set_status (open, active, completed, cancelled; requireReady refuses with not_ready unless the task is ready at commit), task.move (parent null for root), dependency.add, dependency.remove. Refer to existing tasks by {id} and to tasks created earlier in the batch by {key}. Pass expectedUpdatedAt to refuse a change if the task moved on. Every operation applies or none does; a refusal returns {error: {code, message}}.",
      inputSchema: changeInput,
      outputSchema: taskChangeResultSchema,
    },
    ({ workspace, ...change }) =>
      answer(run, workspace, { change, kind: "change" }, asIs)
  );
}
