import type { Page } from "@foundry/core/pagination";
import type {
  ReadyQuery,
  Task,
  TaskChange,
  TaskChangeResult,
  TaskErrorCode,
  TaskNode,
  TaskQuery,
  TaskRelations,
  Tasks,
} from "@foundry/tasks";
import { TaskError } from "@foundry/tasks";

/**
 * What the CLI and the MCP tools ask of a workspace's backlog. Every write
 * is one `TaskChange` batch, so the package checks hierarchy, cycles,
 * statuses, and tokens once, whichever edge sent it; reads are the package's
 * own queries.
 */
interface TaskCommandInputs {
  readonly change: { readonly change: TaskChange };
  readonly dependencies: { readonly id: string };
  readonly get: { readonly depth?: number; readonly id: string };
  readonly list: { readonly query: TaskQuery };
  readonly ready: { readonly query: ReadyQuery };
}

interface TaskCommandResults {
  readonly change: TaskChangeResult;
  readonly dependencies: TaskRelations;
  readonly get: TaskNode;
  readonly list: Page<TaskNode, number>;
  readonly ready: Page<Task, number>;
}

export type TaskCommandKind = keyof TaskCommandInputs;

export type TaskCommand<K extends TaskCommandKind = TaskCommandKind> = {
  readonly [P in K]: { readonly kind: P } & TaskCommandInputs[P];
}[K];

export type TaskCommandResult<K extends TaskCommandKind = TaskCommandKind> =
  TaskCommandResults[K];

const RUN: {
  readonly [K in TaskCommandKind]: (
    tasks: Tasks,
    command: TaskCommand<K>
  ) => Promise<TaskCommandResults[K]>;
} = {
  change: (tasks, { change }) => tasks.change(change),
  dependencies: (tasks, { id }) => tasks.dependencies(id),
  get: async (tasks, { depth, id }) => {
    const task = await tasks.get(id, depth === undefined ? {} : { depth });
    if (task === null) {
      throw new TaskError("not_found", `Task ${id} not found`);
    }
    return task;
  },
  list: (tasks, { query }) => tasks.list(query),
  ready: (tasks, { query }) => tasks.ready(query),
};

/** Runs one command; a refusal is the package's `TaskError`. */
export function runTaskCommand<K extends TaskCommandKind>(
  tasks: Tasks,
  command: TaskCommand<K>
): Promise<TaskCommandResult<K>> {
  const run: (
    tasks: Tasks,
    command: TaskCommand<K>
  ) => Promise<TaskCommandResult<K>> = RUN[command.kind];
  return run(tasks, command);
}

/** A refusal as an edge reports it: the stable code and the message. */
export interface TaskRefusal {
  readonly code: TaskErrorCode;
  readonly message: string;
}

export function taskRefusal(error: TaskError): TaskRefusal {
  return { code: error.code, message: error.message };
}
