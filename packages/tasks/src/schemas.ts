import { z } from "zod";
import { taskSchema, taskStatusSchema } from "./schema";
import { taskId } from "./types";

const taskIdInput = z.string().min(1).transform(taskId);
/** Exact strings, as create and update take them in `taskChangeSchema`. */
const tagsSchema = z.array(z.string()).readonly();

/** Every tag in `all`, and one in a nonempty `any`. */
const tagQuerySchema = z.strictObject({
  all: tagsSchema.optional(),
  any: tagsSchema.optional(),
});

const pageInput = {
  /** Offset into the ordered results; the previous page's `nextCursor`. */
  cursor: z.int().min(0).optional(),
  /** Positive; the package caps it at its maximum page size. */
  limit: z.int().min(1).optional(),
};

const depth = { depth: z.int().min(0).optional() };

export const depthOptionsSchema = z.strictObject(depth);

export const taskQuerySchema = z.strictObject({
  ...pageInput,
  ...depth,
  parentId: taskIdInput.nullable().optional(),
  status: taskStatusSchema.optional(),
  tags: tagQuerySchema.optional(),
});

export const readyQuerySchema = z.strictObject({
  ...pageInput,
  tags: tagQuerySchema.optional(),
});

export const taskNodeSchema = taskSchema.extend({
  get subtasks() {
    return z.array(taskNodeSchema).optional();
  },
});

/** A page of `list` or `ready`; `ready` items carry no `subtasks`. */
export const taskPageSchema = z.strictObject({
  items: z.array(taskNodeSchema),
  nextCursor: z.int().min(0).optional(),
  total: z.int().min(0),
});

export const taskRelationsSchema = z.strictObject({
  dependents: z.array(taskSchema),
  dependsOn: z.array(taskSchema),
});

export const taskChangeResultSchema = z.strictObject({
  changed: z.array(
    z.strictObject({ id: z.string().min(1), key: z.string().optional() })
  ),
  tasks: z.array(taskSchema),
});
