import type { JsonValue } from "@foundry/lib/json";
import { z } from "zod";

/**
 * The records a `TaskStore` keeps and returns: tasks, the dependency edges
 * between them, and the `TaskEvent` a committing write carries. Each record
 * type is inferred from its schema, so the schema is the one definition of
 * the persisted shape; only the `TaskId` brand and `JsonObject` are declared
 * by hand, with their schemas bound to them. Nothing parses these on the way
 * into or out of a store; a store enforces nothing (see `TaskStore`).
 */

/** Branded where the package resolved or generated it. */
export type TaskId = string & { readonly __brand: "TaskId" };

/**
 * Any nonempty string. Bound to the repo's `__brand` type the way
 * `taskMetadataSchema` is bound to `JsonObject`: a transform would make the
 * schema unrepresentable as JSON Schema, which MCP tools publish.
 */
export const taskIdSchema = z.string().min(1) as unknown as z.ZodType<
  TaskId,
  string
>;

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

/** An ISO 8601 instant in UTC, as `Date.prototype.toISOString` writes it. */
const instant = z.iso.datetime();

/**
 * One unit of work, exactly as the store holds it. Strict, and left without
 * `.readonly()`: MCP tools publish it as an output schema.
 */
export const taskSchema = z.strictObject({
  createdAt: instant,
  description: z.string().nullable(),
  id: taskIdSchema,
  metadata: taskMetadataSchema,
  /** `null` for a root task. Hierarchy is a plain parent reference. */
  parentId: taskIdSchema.nullable(),
  /** Set when the task entered a settled status; cleared on reopen. */
  settledAt: instant.nullable(),
  status: taskStatusSchema,
  /** Exact strings, each once, in the order first given. */
  tags: z.array(z.string()).readonly(),
  title: z.string().min(1),
  /** The optimistic token: strictly later on every write. */
  updatedAt: instant,
});
export type Task = Readonly<z.infer<typeof taskSchema>>;

const storedTask = taskSchema.readonly();

/** An existing `dependsOnId` blocks `taskId` until it settles either way. */
export const taskDependencySchema = z
  .strictObject({ dependsOnId: taskIdSchema, taskId: taskIdSchema })
  .readonly();
export type TaskDependency = z.infer<typeof taskDependencySchema>;

const dependencies = z.array(taskDependencySchema).readonly();

/** One task as one committed write found it and left it. */
export const taskDeltaSchema = z
  .strictObject({
    /** `null` when the write removed it. */
    after: storedTask.nullable(),
    /** `null` when the write created it. */
    before: storedTask.nullable(),
    id: taskIdSchema,
  })
  .readonly();
export type TaskDelta = z.infer<typeof taskDeltaSchema>;

/**
 * What one committed write changed: each task it put or removed, once, with
 * the record before and after the whole write, and the dependency edges it
 * added or removed. A task an operation only named is not in it, and an
 * edge added and removed again in one batch is in neither list.
 */
export const taskEventSchema = z
  .strictObject({
    dependencies: z
      .strictObject({ added: dependencies, removed: dependencies })
      .readonly(),
    kind: z.literal("tasks.changed"),
    tasks: z.array(taskDeltaSchema).readonly(),
  })
  .readonly();
export type TaskEvent = z.infer<typeof taskEventSchema>;

/** Everything the store holds; the package resolves the graph over it. */
export const taskSnapshotSchema = z
  .strictObject({ dependencies, tasks: z.array(storedTask).readonly() })
  .readonly();
export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;

/** One atomic write. Deletes apply before puts. */
export const taskStoreWriteSchema = z
  .strictObject({
    deleteDependencies: dependencies.optional(),
    deleteTasks: z.array(taskIdSchema).readonly().optional(),
    /**
     * What the write changes, present whenever it changes anything. A store
     * that records changes keeps it in the same atomic write; one that does
     * not ignores it.
     */
    event: taskEventSchema.optional(),
    putDependencies: dependencies.optional(),
    putTasks: z.array(storedTask).readonly().optional(),
  })
  .readonly();
export type TaskStoreWrite = z.infer<typeof taskStoreWriteSchema>;
