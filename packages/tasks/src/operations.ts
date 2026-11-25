import { z } from "zod";
import {
  type JsonObject,
  type Task,
  type TaskId,
  type TaskStatus,
  taskMetadataSchema,
  taskSchema,
  taskStatusSchema,
} from "./schema";

export type TaskRef = { readonly id: string } | { readonly key: string };

export interface CreateTaskInput {
  readonly description?: string | null;
  readonly id?: string;
  readonly metadata?: JsonObject;
  readonly status?: TaskStatus;
  readonly tags?: readonly string[];
  readonly title: string;
}

export interface UpdateTaskInput {
  readonly description?: string | null;
  readonly metadata?: JsonObject;
  readonly tags?: readonly string[];
  readonly title?: string;
}

export interface TaskToken {
  readonly expectedUpdatedAt?: string;
}

export type TaskOperation =
  | {
      readonly kind: "task.create";
      readonly key: string;
      readonly input: CreateTaskInput;
      readonly parent?: TaskRef;
    }
  | ({
      readonly kind: "task.update";
      readonly task: TaskRef;
      readonly patch: UpdateTaskInput;
    } & TaskToken)
  | ({
      readonly kind: "task.set_status";
      readonly requireReady?: boolean;
      readonly task: TaskRef;
      readonly status: TaskStatus;
    } & TaskToken)
  | ({
      readonly kind: "task.move";
      readonly task: TaskRef;
      readonly parent: TaskRef | null;
    } & TaskToken)
  | {
      readonly kind: "dependency.add";
      readonly task: TaskRef;
      readonly dependsOn: TaskRef;
    }
  | {
      readonly kind: "dependency.remove";
      readonly task: TaskRef;
      readonly dependsOn: TaskRef;
    };

export interface TaskChange {
  readonly operations: readonly TaskOperation[];
}

export interface ChangedTask {
  readonly id: TaskId;
  readonly key?: string;
}

export interface TaskChangeResult {
  readonly changed: readonly ChangedTask[];
  readonly tasks: readonly Task[];
}

export const MAX_OPERATIONS_PER_CHANGE = 100;

const nonEmpty = z.string().min(1);
const tagsSchema = z.array(z.string()).readonly();

const taskRefSchema: z.ZodType<TaskRef, TaskRef> = z.union([
  z.strictObject({ id: nonEmpty }),
  z.strictObject({ key: nonEmpty }),
]);

const token = { expectedUpdatedAt: z.iso.datetime().optional() };

export const taskOperationSchema: z.ZodType<TaskOperation, TaskOperation> =
  z.discriminatedUnion("kind", [
    z.strictObject({
      input: z.strictObject({
        description: z.string().nullable().optional(),
        id: nonEmpty.optional(),
        metadata: taskMetadataSchema.optional(),
        status: taskStatusSchema.optional(),
        tags: tagsSchema.optional(),
        title: nonEmpty,
      }),
      key: nonEmpty,
      kind: z.literal("task.create"),
      parent: taskRefSchema.optional(),
    }),
    z.strictObject({
      kind: z.literal("task.update"),
      patch: z.strictObject({
        description: z.string().nullable().optional(),
        metadata: taskMetadataSchema.optional(),
        tags: tagsSchema.optional(),
        title: nonEmpty.optional(),
      }),
      task: taskRefSchema,
      ...token,
    }),
    z.strictObject({
      kind: z.literal("task.set_status"),
      requireReady: z.boolean().optional(),
      status: taskStatusSchema,
      task: taskRefSchema,
      ...token,
    }),
    z.strictObject({
      kind: z.literal("task.move"),
      parent: taskRefSchema.nullable(),
      task: taskRefSchema,
      ...token,
    }),
    z.strictObject({
      dependsOn: taskRefSchema,
      kind: z.literal("dependency.add"),
      task: taskRefSchema,
    }),
    z.strictObject({
      dependsOn: taskRefSchema,
      kind: z.literal("dependency.remove"),
      task: taskRefSchema,
    }),
  ]);

export const taskChangeSchema: z.ZodType<TaskChange, TaskChange> =
  z.strictObject({
    operations: z
      .array(taskOperationSchema)
      .min(1)
      .max(MAX_OPERATIONS_PER_CHANGE),
  });

export const taskChangeResultSchema = z.strictObject({
  changed: z.array(
    z.strictObject({ id: z.string().min(1), key: z.string().optional() })
  ),
  tasks: z.array(taskSchema),
});
