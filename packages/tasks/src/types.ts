import type { PageInput } from "@foundry/core/pagination";
import type { Task, TaskId, TaskStatus } from "./schema";

export type SettledStatus = Extract<TaskStatus, "completed" | "cancelled">;

export type TaskAvailability =
  | { readonly kind: "ready" }
  | { readonly kind: "active" }
  | {
      readonly kind: "blocked";
      readonly blockedBy: readonly TaskId[];
      readonly waitingOn: readonly TaskId[];
    }
  | { readonly kind: "settled"; readonly status: SettledStatus };

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

export function isSettled(status: TaskStatus): status is SettledStatus {
  return status === "completed" || status === "cancelled";
}

export function taskId(value: string): TaskId {
  return value as TaskId;
}
