import type { TaskSnapshot } from "./store";
import type { Task, TaskAvailability, TaskId } from "./types";
import { isSettled } from "./types";

export interface AvailabilityOptions {
  /**
   * When on, an open task also waits for every open ancestor: a parent has to
   * be started (or settled) before its children are offered. Off by default.
   */
  readonly parentGate?: boolean;
}

/**
 * Pure readiness over one snapshot: which open tasks can be offered as new
 * work, and what holds the others back. Stores nothing and claims nothing.
 *
 * A dependency stops blocking once its target has settled either way;
 * cancelled work would otherwise strand its dependents. A dependency whose
 * target is missing from the snapshot cannot block.
 */
export function deriveAvailability(
  snapshot: TaskSnapshot,
  options: AvailabilityOptions = {}
): ReadonlyMap<TaskId, TaskAvailability> {
  const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const dependsOn = new Map<TaskId, TaskId[]>();
  for (const edge of snapshot.dependencies) {
    const targets = dependsOn.get(edge.taskId) ?? [];
    targets.push(edge.dependsOnId);
    dependsOn.set(edge.taskId, targets);
  }

  const result = new Map<TaskId, TaskAvailability>();
  for (const task of snapshot.tasks) {
    result.set(task.id, availabilityOf(task, byId, dependsOn, options));
  }
  return result;
}

function availabilityOf(
  task: Task,
  byId: ReadonlyMap<TaskId, Task>,
  dependsOn: ReadonlyMap<TaskId, readonly TaskId[]>,
  options: AvailabilityOptions
): TaskAvailability {
  if (isSettled(task.status)) {
    return { kind: "settled", status: task.status };
  }
  if (task.status === "active") {
    return { kind: "active" };
  }
  const blockedBy = (dependsOn.get(task.id) ?? []).filter((targetId) => {
    const target = byId.get(targetId);
    return target !== undefined && !isSettled(target.status);
  });
  const waitingOn = options.parentGate ? openAncestors(task, byId) : [];
  if (blockedBy.length > 0 || waitingOn.length > 0) {
    return { blockedBy, kind: "blocked", waitingOn };
  }
  return { kind: "ready" };
}

/** Open ancestors, nearest first. A parent cycle in the data ends the walk. */
function openAncestors(task: Task, byId: ReadonlyMap<TaskId, Task>): TaskId[] {
  const waiting: TaskId[] = [];
  const seen = new Set<TaskId>([task.id]);
  let parent = parentOf(task, byId);
  while (parent !== undefined && !seen.has(parent.id)) {
    seen.add(parent.id);
    if (parent.status === "open") {
      waiting.push(parent.id);
    }
    parent = parentOf(parent, byId);
  }
  return waiting;
}

function parentOf(
  task: Task,
  byId: ReadonlyMap<TaskId, Task>
): Task | undefined {
  return task.parentId === null ? undefined : byId.get(task.parentId);
}
