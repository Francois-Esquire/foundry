import type { JsonValue } from "@foundry/lib/json";
import { z } from "zod";

export type TaskId = string & { readonly __brand: "TaskId" };

const taskIdSchema = z.string().min(1) as unknown as z.ZodType<TaskId, string>;

export const TASK_STATUSES = [
  "open",
  "active",
  "completed",
  "cancelled",
] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const taskMetadataSchema = z.preprocess(
  (value, context) => {
    const problem = unsafeProperty(value, []);
    if (problem !== undefined) {
      context.addIssue({ code: "custom", ...problem });
    }
    return value;
  },
  z.record(z.string(), z.json())
) as z.ZodType<JsonObject, JsonObject>;

function unsafeProperty(
  value: unknown,
  path: readonly (number | string)[]
):
  | { readonly message: string; readonly path: (number | string)[] }
  | undefined {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const array = Array.isArray(value);
  for (const [key, property] of Object.entries(
    Object.getOwnPropertyDescriptors(value)
  )) {
    const at = [...path, array ? Number(key) : key];
    if (key === "__proto__" && !array) {
      return {
        message: '"__proto__" is not allowed as a metadata key',
        path: at,
      };
    }
    if (!("value" in property)) {
      return { message: "A getter is not JSON data", path: at };
    }
    const problem = unsafeProperty(property.value, at);
    if (problem !== undefined) {
      return problem;
    }
  }
}

const instant = z.iso.datetime();

export const taskSchema = z.strictObject({
  createdAt: instant,
  description: z.string().nullable(),
  id: taskIdSchema,
  metadata: taskMetadataSchema,
  parentId: taskIdSchema.nullable(),
  settledAt: instant.nullable(),
  status: taskStatusSchema,
  tags: z.array(z.string()).readonly(),
  title: z.string().min(1),
  updatedAt: instant,
});
export type Task = Readonly<z.infer<typeof taskSchema>>;

const storedTask = taskSchema.readonly();

export const taskDependencySchema = z
  .strictObject({ dependsOnId: taskIdSchema, taskId: taskIdSchema })
  .readonly();
export type TaskDependency = z.infer<typeof taskDependencySchema>;

const dependencies = z.array(taskDependencySchema).readonly();

const taskDeltaSchema = z
  .strictObject({
    after: storedTask.nullable(),
    before: storedTask.nullable(),
    id: taskIdSchema,
  })
  .readonly();
export type TaskDelta = z.infer<typeof taskDeltaSchema>;

export const taskEventSchema = z
  .strictObject({
    at: z.iso.datetime(),
    dependencies: z
      .strictObject({ added: dependencies, removed: dependencies })
      .readonly(),
    id: z.string().min(1),
    tasks: z.array(taskDeltaSchema).readonly(),
    type: z.literal("tasks.changed"),
  })
  .readonly();
export type TaskEvent = z.infer<typeof taskEventSchema>;

export const taskSnapshotSchema = z
  .strictObject({ dependencies, tasks: z.array(storedTask).readonly() })
  .readonly();
export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;

export const taskStoreWriteSchema = z
  .strictObject({
    deleteDependencies: dependencies.exactOptional(),
    deleteTasks: z.array(taskIdSchema).readonly().exactOptional(),
    events: z.array(taskEventSchema).readonly().exactOptional(),
    expectedUpdatedAt: z
      .record(z.string(), instant.nullable())
      .readonly()
      .exactOptional(),
    putDependencies: dependencies.exactOptional(),
    putTasks: z.array(storedTask).readonly().exactOptional(),
  })
  .readonly();
export type TaskStoreWrite = z.infer<typeof taskStoreWriteSchema>;

export function taskId(value: string): TaskId {
  return value as TaskId;
}

export function edgeKey(edge: TaskDependency): string {
  return JSON.stringify([edge.taskId, edge.dependsOnId]);
}
