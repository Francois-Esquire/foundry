import type { PageInput } from "@foundry/core/pagination";
import { z } from "zod";
import type { Task, TaskId, TaskStatus } from "./schema";
import { taskId, taskSchema, taskStatusSchema } from "./schema";

export interface TaskNode extends Task {
  readonly subtasks?: readonly TaskNode[];
}

export interface DepthOptions {
  readonly depth?: number;
}

export interface TagQuery {
  readonly all?: readonly string[];
  readonly any?: readonly string[];
}

export interface TaskQuery extends PageInput<number>, DepthOptions {
  readonly parentId?: TaskId | null;
  readonly status?: TaskStatus;
  readonly tags?: TagQuery;
}

export interface ReadyQuery extends PageInput<number> {
  readonly tags?: TagQuery;
}

export interface TaskRelations {
  readonly dependents: readonly Task[];
  readonly dependsOn: readonly Task[];
}

const taskIdInput = z.string().min(1).transform(taskId);
const tagsSchema = z.array(z.string()).readonly();

const tagQuerySchema = z.strictObject({
  all: tagsSchema.optional(),
  any: tagsSchema.optional(),
});

const pageInput = {
  cursor: z.int().min(0).optional(),
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

export const taskPageSchema = z.strictObject({
  items: z.array(taskNodeSchema),
  nextCursor: z.int().min(0).optional(),
  total: z.int().min(0),
});

export const taskRelationsSchema = z.strictObject({
  dependents: z.array(taskSchema),
  dependsOn: z.array(taskSchema),
});
