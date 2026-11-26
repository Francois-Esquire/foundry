import type { Task, TaskId, TaskSnapshot, TaskStatus } from "./schema";

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

export function isSettled(status: TaskStatus): status is SettledStatus {
  return status === "completed" || status === "cancelled";
}

export interface AvailabilityOptions {
  readonly parentGate?: boolean;
}

export function deriveAvailability(
  snapshot: TaskSnapshot,
  options: AvailabilityOptions = {}
): ReadonlyMap<TaskId, TaskAvailability> {
  const index = indexSnapshot(snapshot);
  const result = new Map<TaskId, TaskAvailability>();
  for (const task of snapshot.tasks) {
    result.set(task.id, availabilityOf(task, index, options));
  }
  return result;
}

export function availabilityIn(
  snapshot: TaskSnapshot,
  id: TaskId,
  options: AvailabilityOptions = {}
): TaskAvailability | null {
  const index = indexSnapshot(snapshot);
  const task = index.byId.get(id);
  return task === undefined ? null : availabilityOf(task, index, options);
}

export function readyTaskIds(
  snapshot: TaskSnapshot,
  options: AvailabilityOptions = {}
): ReadonlySet<TaskId> {
  const index = indexSnapshot(snapshot);
  const hasOpenAncestor = options.parentGate
    ? openAncestry(index.byId)
    : () => false;
  const ready = new Set<TaskId>();
  for (const task of index.byId.values()) {
    if (
      task.status === "open" &&
      blockedByOf(task, index).length === 0 &&
      !hasOpenAncestor(task)
    ) {
      ready.add(task.id);
    }
  }
  return ready;
}

interface SnapshotIndex {
  readonly byId: ReadonlyMap<TaskId, Task>;
  readonly dependsOn: ReadonlyMap<TaskId, readonly TaskId[]>;
}

function indexSnapshot(snapshot: TaskSnapshot): SnapshotIndex {
  const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const dependsOn = new Map<TaskId, TaskId[]>();
  for (const edge of snapshot.dependencies) {
    const targets = dependsOn.get(edge.taskId) ?? [];
    targets.push(edge.dependsOnId);
    dependsOn.set(edge.taskId, targets);
  }
  return { byId, dependsOn };
}

function availabilityOf(
  task: Task,
  index: SnapshotIndex,
  options: AvailabilityOptions
): TaskAvailability {
  if (isSettled(task.status)) {
    return { kind: "settled", status: task.status };
  }
  if (task.status === "active") {
    return { kind: "active" };
  }
  const blockedBy = blockedByOf(task, index);
  const waitingOn = options.parentGate ? openAncestors(task, index.byId) : [];
  if (blockedBy.length > 0 || waitingOn.length > 0) {
    return { blockedBy, kind: "blocked", waitingOn };
  }
  return { kind: "ready" };
}

function blockedByOf(task: Task, index: SnapshotIndex): TaskId[] {
  return (index.dependsOn.get(task.id) ?? []).filter((targetId) => {
    const target = index.byId.get(targetId);
    return target !== undefined && !isSettled(target.status);
  });
}

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

function openAncestry(
  byId: ReadonlyMap<TaskId, Task>
): (task: Task) => boolean {
  const known = new Map<TaskId, boolean>();
  return (task) => {
    const climb: Task[] = [];
    const onClimb = new Map<TaskId, number>();
    let top: Task | undefined = task;
    while (top !== undefined && !known.has(top.id) && !onClimb.has(top.id)) {
      onClimb.set(top.id, climb.length);
      climb.push(top);
      top = parentOf(top, byId);
    }

    let openAbove = false;
    if (top !== undefined) {
      const start = onClimb.get(top.id);
      if (start === undefined) {
        openAbove = known.get(top.id) === true || top.status === "open";
      } else {
        const cycle = climb.splice(start);
        const open = cycle.filter((member) => member.status === "open").length;
        for (const member of cycle) {
          known.set(member.id, open - (member.status === "open" ? 1 : 0) > 0);
        }
        openAbove = open > 0;
      }
    }

    for (const below of climb.reverse()) {
      known.set(below.id, openAbove);
      openAbove ||= below.status === "open";
    }
    return known.get(task.id) === true;
  };
}

function parentOf(
  task: Task,
  byId: ReadonlyMap<TaskId, Task>
): Task | undefined {
  return task.parentId === null ? undefined : byId.get(task.parentId);
}
