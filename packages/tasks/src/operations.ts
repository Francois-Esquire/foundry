import { z } from "zod";
import type { JsonObject, Task, TaskId, TaskStatus } from "./types";
import { TASK_STATUSES } from "./types";

/**
 * The command language. A change is a batch of operations applied atomically;
 * every edge (code, CLI, MCP tools) submits the same shape and the graph
 * rules — hierarchy, cycles, status transitions, tokens — are enforced once.
 */

/** A persistent task by id, or one created earlier in the same batch by key. */
export type TaskRef = { readonly id: string } | { readonly key: string };

export interface CreateTaskInput {
  readonly description?: string | null;
  /** Caller-supplied identity; the package generates one when omitted. */
  readonly id?: string;
  readonly metadata?: JsonObject;
  readonly status?: TaskStatus;
  readonly title: string;
}

export interface UpdateTaskInput {
  readonly description?: string | null;
  readonly metadata?: JsonObject;
  readonly title?: string;
}

/** Optimistic token: the exact `updatedAt` the caller last read. */
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
      readonly task: TaskRef;
      readonly status: TaskStatus;
    } & TaskToken)
  | ({
      readonly kind: "task.move";
      readonly task: TaskRef;
      /** `null` makes the task a root. */
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
  /** The batch-local key, when the task was created in this batch. */
  readonly key?: string;
}

export interface TaskChangeResult {
  readonly changed: readonly ChangedTask[];
  /** Committed records of every task the batch created or touched. */
  readonly tasks: readonly Task[];
}

export const MAX_OPERATIONS_PER_CHANGE = 100;

const taskStatusSchema = z.enum(TASK_STATUSES);
const nonEmpty = z.string().min(1);
export const taskMetadataSchema = z.record(z.string(), z.json());

export const taskRefSchema: z.ZodType<TaskRef, TaskRef> = z.union([
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
        title: nonEmpty.optional(),
      }),
      task: taskRefSchema,
      ...token,
    }),
    z.strictObject({
      kind: z.literal("task.set_status"),
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
