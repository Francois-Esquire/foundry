import type { PageInput } from "@foundry/core/pagination";
import type { JsonValue } from "@foundry/lib/json";

export type TaskId = string & { readonly __brand: "TaskId" };

export const TASK_STATUSES = [
  "open",
  "active",
  "completed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type SettledStatus = Extract<TaskStatus, "completed" | "cancelled">;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** One unit of work, exactly as the store holds it. */
export interface Task {
  /** ISO 8601 instants. */
  readonly createdAt: string;
  readonly description: string | null;
  readonly id: TaskId;
  readonly metadata: JsonObject;
  /** `null` for a root task. Hierarchy is a plain parent reference. */
  readonly parentId: TaskId | null;
  /** Set when the task entered a settled status; cleared on reopen. */
  readonly settledAt: string | null;
  readonly status: TaskStatus;
  /** Exact strings, each once, in the order first given. */
  readonly tags: readonly string[];
  readonly title: string;
  readonly updatedAt: string;
}

/** `taskId` is not ready until `dependsOnId` has settled either way. */
export interface TaskDependency {
  readonly dependsOnId: TaskId;
  readonly taskId: TaskId;
}

/** Whether a task can be offered as new work, and if not, why. */
export type TaskAvailability =
  | { readonly kind: "ready" }
  | { readonly kind: "active" }
  | {
      readonly kind: "blocked";
      /** Unsettled dependency targets. */
      readonly blockedBy: readonly TaskId[];
      /** Open ancestors, nearest first; only with the parent gate on. */
      readonly waitingOn: readonly TaskId[];
    }
  | { readonly kind: "settled"; readonly status: SettledStatus };

/** A task with `subtasks` present when a read expanded beneath it. */
export interface TaskNode extends Task {
  /** Absent at the depth limit; an empty array means no children. */
  readonly subtasks?: readonly TaskNode[];
}

export interface DepthOptions {
  /** Levels of subtasks to include beneath each task returned. 0 by default. */
  readonly depth?: number;
}

/**
 * Tasks carrying every tag in `all` and at least one in `any`. An omitted or
 * empty list imposes nothing.
 */
export interface TagQuery {
  readonly all?: readonly string[];
  readonly any?: readonly string[];
}

export interface TaskQuery extends PageInput<number>, DepthOptions {
  /** `null` selects root tasks; omit to select every task. */
  readonly parentId?: TaskId | null;
  readonly status?: TaskStatus;
  readonly tags?: TagQuery;
}

export interface ReadyQuery extends PageInput<number> {
  readonly tags?: TagQuery;
}

export interface TaskRelations {
  /** Tasks waiting on this one. */
  readonly dependents: readonly Task[];
  /** Tasks this one waits on. */
  readonly dependsOn: readonly Task[];
}

/** One task as one committed write found it and left it. */
export interface TaskDelta {
  /** `null` when the write removed it. */
  readonly after: Task | null;
  /** `null` when the write created it. */
  readonly before: Task | null;
  readonly id: TaskId;
}

/**
 * What one committed write changed: each task it put or removed, once, with
 * the record before and after the whole write, and the dependency edges it
 * added or removed. A task an operation only named is not in it, and an
 * edge added and removed again in one batch is in neither list.
 */
export interface TaskEvent {
  readonly dependencies: {
    readonly added: readonly TaskDependency[];
    readonly removed: readonly TaskDependency[];
  };
  readonly kind: "tasks.changed";
  readonly tasks: readonly TaskDelta[];
}

export function isSettled(status: TaskStatus): status is SettledStatus {
  return status === "completed" || status === "cancelled";
}

/** Brands a caller-supplied string; existence is checked where it matters. */
export function taskId(value: string): TaskId {
  return value as TaskId;
}
