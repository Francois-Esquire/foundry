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
  /** Exact strings; repeats collapse to the first. None when omitted. */
  readonly tags?: readonly string[];
  readonly title: string;
}

export interface UpdateTaskInput {
  readonly description?: string | null;
  /**
   * Sets each top-level key over the stored metadata; a key whose value is
   * `null` is removed, and a key left out is kept. A nested value replaces
   * the stored value for its key whole.
   */
  readonly metadata?: JsonObject;
  /** Replaces every tag; `[]` clears them and omission keeps them. */
  readonly tags?: readonly string[];
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
      /**
       * Refuse with `not_ready` unless the task is ready as the batch finds
       * it: open, with existing dependencies settled and every open ancestor
       * started when the parent gate is on. The check uses the batch working
       * copy at this operation; later operations are not rechecked. Exclusion
       * from other instances requires a store transaction.
       */
      readonly requireReady?: boolean;
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
  /** Every task an operation named, including parents and dependency targets. */
  readonly changed: readonly ChangedTask[];
  /** The committed record of every task in `changed`, in the same order. */
  readonly tasks: readonly Task[];
}

export const MAX_OPERATIONS_PER_CHANGE = 100;

const taskStatusSchema = z.enum(TASK_STATUSES);
const nonEmpty = z.string().min(1);
/**
 * A JSON object, read once into a fresh copy. A `__proto__` key is refused
 * at any depth, since Zod would drop it. So is a getter: the check and the
 * copy would each read it, and could see different values.
 * On update, a `null` value removes its key; see `UpdateTaskInput`.
 */
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

/** Where and why `value` cannot be read as plain JSON without losing a key. */
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
const tagsSchema = z.array(z.string()).readonly();

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
