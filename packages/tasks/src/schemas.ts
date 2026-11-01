import { z } from "zod";
import { taskMetadataSchema } from "./operations";
import { TASK_STATUSES, taskId } from "./types";

/**
 * Runtime shapes for reads: the records the package returns and the queries
 * it takes, for edges (CLI, MCP tools) that check values crossing a process
 * boundary. Queries are strict, so a filter the package does not apply is
 * refused rather than ignored. A field added to a record or query type
 * belongs here too; the package tests parse real records strictly.
 */

const taskIdInput = z.string().min(1).transform(taskId);
const instant = z.iso.datetime();
const taskStatusSchema = z.enum(TASK_STATUSES);
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

export const taskSchema = z.strictObject({
  createdAt: instant,
  description: z.string().nullable(),
  id: z.string().min(1),
  metadata: taskMetadataSchema,
  parentId: z.string().min(1).nullable(),
  settledAt: instant.nullable(),
  status: taskStatusSchema,
  tags: tagsSchema,
  title: z.string().min(1),
  updatedAt: instant,
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
