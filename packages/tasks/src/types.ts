import type { PageInput } from "@foundry/core/pagination";
import type { Task, TaskId, TaskStatus } from "./schema";

export type SettledStatus = Extract<TaskStatus, "completed" | "cancelled">;

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

export function isSettled(status: TaskStatus): status is SettledStatus {
  return status === "completed" || status === "cancelled";
}

/** Brands a caller-supplied string; existence is checked where it matters. */
export function taskId(value: string): TaskId {
  return value as TaskId;
}
