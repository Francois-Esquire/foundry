import type { Tasks } from "@foundry/tasks";
import {
  depthOptionsSchema,
  readyQuerySchema,
  TaskError,
  taskChangeSchema,
  taskQuerySchema,
} from "@foundry/tasks";
import { z } from "zod";

import type {
  TaskCommand,
  TaskCommandKind,
  TaskCommandResult,
  TaskOutcome,
  TaskRefusal,
} from "~/model/tasks";

const RUN: {
  readonly [K in TaskCommandKind]: (
    tasks: Tasks,
    command: TaskCommand<K>
  ) => Promise<TaskCommandResult<K>>;
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

export function taskRefusal(error: TaskError): TaskRefusal {
  return { code: error.code, message: error.message };
}

export async function taskOutcome<K extends TaskCommandKind>(
  work: Promise<TaskCommandResult<K>>
): Promise<TaskOutcome<K>> {
  try {
    return { result: await work };
  } catch (error) {
    if (error instanceof TaskError) {
      return { refusal: taskRefusal(error) };
    }
    throw error;
  }
}

export const taskCommandSchema: z.ZodType<TaskCommand> = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({ change: taskChangeSchema, kind: z.literal("change") }),
    z.strictObject({
      id: z.string().min(1),
      kind: z.literal("dependencies"),
    }),
    depthOptionsSchema.extend({
      id: z.string().min(1),
      kind: z.literal("get"),
    }),
    z.strictObject({ kind: z.literal("list"), query: taskQuerySchema }),
    z.strictObject({ kind: z.literal("ready"), query: readyQuerySchema }),
  ]
);
