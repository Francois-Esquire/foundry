/**
 * `@foundry/tasks` — the backlog.
 *
 * A Task says what there is to do; `ready()` says what is next; a settled
 * status says what is done. Dependencies and a parent reference shape the
 * graph and availability is derived from it. Changes use an atomic batch
 * language shared by code, CLI, and agent tools; removal is separate.
 * Execution lives in workflows; a Job correlates to a task by id only.
 */

export type { AvailabilityOptions } from "./availability";
// biome-ignore lint/performance/noBarrelFile: This is a declared package entry point; preserve its public exports.
export { deriveAvailability } from "./availability";
export { TASK_ERROR_CODES, TaskError, type TaskErrorCode } from "./errors";
export type {
  ChangedTask,
  CreateTaskInput,
  TaskChange,
  TaskChangeResult,
  TaskOperation,
  TaskRef,
  TaskToken,
  UpdateTaskInput,
} from "./operations";
export {
  MAX_OPERATIONS_PER_CHANGE,
  taskChangeSchema,
  taskOperationSchema,
} from "./operations";
export type {
  JsonObject,
  Task,
  TaskDelta,
  TaskDependency,
  TaskEvent,
  TaskId,
  TaskStatus,
} from "./schema";
export { TASK_STATUSES, taskSchema } from "./schema";
export {
  depthOptionsSchema,
  readyQuerySchema,
  taskChangeResultSchema,
  taskNodeSchema,
  taskPageSchema,
  taskQuerySchema,
  taskRelationsSchema,
} from "./schemas";
export type { TaskSnapshot, TaskStore, TaskStoreWrite } from "./store";
export { MemoryTaskStore } from "./store";
export { type CreateOptions, Tasks, type TasksOptions } from "./tasks";
export type {
  DepthOptions,
  ReadyQuery,
  SettledStatus,
  TagQuery,
  TaskAvailability,
  TaskNode,
  TaskQuery,
  TaskRelations,
} from "./types";
export { isSettled, taskId } from "./types";
