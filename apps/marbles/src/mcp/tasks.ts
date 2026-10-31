import type { Tasks } from "@foundry/tasks";
import {
  depthOptionsSchema,
  readyQuerySchema,
  TaskError,
  taskChangeResultSchema,
  taskChangeSchema,
  taskNodeSchema,
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
} from "~/tasks/command";
import { runTaskCommand, taskRefusal } from "~/tasks/command";

/**
 * Runs one command and answers with its result as structured content, which
 * the server checks against the tool's output schema. A refusal from the
 * package is a tool error carrying `{ error: { code, message } }` as text.
 */
async function answer<K extends TaskCommandKind>(
  tasks: Tasks,
  command: TaskCommand<K>,
  shape: (result: TaskCommandResult<K>) => Record<string, unknown>
): Promise<CallToolResult> {
  try {
    const structured = shape(await runTaskCommand(tasks, command));
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
 * refusals as `marbles tasks`. Reads change nothing; `change_tasks` takes one
 * atomic batch in the task command language.
 */
export function registerTaskTools(server: McpServer, tasks: Tasks): void {
  server.registerTool(
    "list_tasks",
    {
      annotations: { readOnlyHint: true },
      description:
        "List this workspace's tasks, oldest first, optionally by status or parent (parentId null for root tasks). depth expands subtasks. Paginated: pass the returned nextCursor as cursor; limit is capped by the backlog.",
      inputSchema: taskQuerySchema,
      outputSchema: taskPageSchema,
    },
    (query) => answer(tasks, { kind: "list", query }, asIs)
  );
  server.registerTool(
    "ready_tasks",
    {
      annotations: { readOnlyHint: true },
      description:
        "List open tasks nothing holds back, oldest first: what is next. Paginated like list_tasks.",
      inputSchema: readyQuerySchema,
      outputSchema: taskPageSchema,
    },
    (query) => answer(tasks, { kind: "ready", query }, asIs)
  );
  server.registerTool(
    "get_task",
    {
      annotations: { readOnlyHint: true },
      description:
        "Read one task by id, with depth levels of subtasks. Its updatedAt is the expectedUpdatedAt token for a change that must not overwrite a newer one.",
      inputSchema: depthOptionsSchema.extend({ id: idInput }),
      outputSchema: z.strictObject({ task: taskNodeSchema }),
    },
    ({ depth, id }) =>
      answer(
        tasks,
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
      inputSchema: z.strictObject({ id: idInput }),
      outputSchema: taskRelationsSchema,
    },
    ({ id }) => answer(tasks, { id, kind: "dependencies" }, asIs)
  );
  server.registerTool(
    "change_tasks",
    {
      annotations: { destructiveHint: false, readOnlyHint: false },
      description:
        "Apply one atomic batch of task operations: task.create (key, input, optional parent), task.update, task.set_status (open, active, completed, cancelled), task.move (parent null for root), dependency.add, dependency.remove. Refer to existing tasks by {id} and to tasks created earlier in the batch by {key}. Pass expectedUpdatedAt to refuse a change if the task moved on. Every operation applies or none does; a refusal returns {error: {code, message}}.",
      inputSchema: taskChangeSchema,
      outputSchema: taskChangeResultSchema,
    },
    (change) => answer(tasks, { change, kind: "change" }, asIs)
  );
}
