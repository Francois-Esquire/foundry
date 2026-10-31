import { edgeKey } from "./edges";
import { TaskError } from "./errors";
import type {
  ChangedTask,
  TaskChange,
  TaskOperation,
  TaskRef,
  TaskToken,
} from "./operations";
import type { TaskSnapshot, TaskStoreWrite } from "./store";
import type {
  Task,
  TaskDelta,
  TaskDependency,
  TaskEvent,
  TaskId,
} from "./types";
import { isSettled, taskId } from "./types";

export interface AppliedChange {
  /**
   * Every task an operation named, in first-mention order: the one it created
   * or acted on first, then its parent or `dependsOn` target.
   */
  readonly changed: readonly ChangedTask[];
  /** The record of every task in `changed`, in the same order. */
  readonly tasks: readonly Task[];
  readonly write: TaskStoreWrite;
}

type Operation<K extends TaskOperation["kind"]> = Extract<
  TaskOperation,
  { kind: K }
>;

const ID_PREFIX = "tk-";
const ID_HEX_LENGTH = 8;
const UUID_DASHES = /-/g;

/**
 * Applies one batch to a working copy of the snapshot and returns the write
 * that commits it. Nothing here touches the store, so a refusal anywhere in
 * the batch leaves it untouched.
 */
export function applyChange(
  snapshot: TaskSnapshot,
  change: TaskChange,
  now: () => string
): AppliedChange {
  if (change.operations.length === 0) {
    throw new TaskError("invalid_operation", "empty operation batch");
  }
  const batch = new Batch(snapshot, now);
  for (const operation of change.operations) {
    batch.apply(operation);
  }
  return batch.result();
}

class Batch {
  private readonly original: TaskSnapshot;
  private readonly tasks: Map<TaskId, Task>;
  private readonly edges: Map<string, TaskDependency>;
  private readonly keys = new Map<string, TaskId>();
  private readonly changed = new Map<TaskId, ChangedTask>();
  private readonly touched = new Set<TaskId>();
  private readonly putEdges = new Map<string, TaskDependency>();
  private readonly deletedEdges = new Map<string, TaskDependency>();
  private readonly now: () => string;

  constructor(snapshot: TaskSnapshot, now: () => string) {
    this.original = snapshot;
    this.tasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
    this.edges = new Map(
      snapshot.dependencies.map((edge) => [edgeKey(edge), edge])
    );
    this.now = now;
  }

  apply(operation: TaskOperation): void {
    switch (operation.kind) {
      case "task.create":
        this.create(operation);
        break;
      case "task.update":
        this.update(operation);
        break;
      case "task.set_status":
        this.setStatus(operation);
        break;
      case "task.move":
        this.move(operation);
        break;
      case "dependency.add":
        this.addDependency(operation);
        break;
      case "dependency.remove":
        this.removeDependency(operation);
        break;
      default:
        throw new TaskError("invalid_operation", "unknown operation");
    }
  }

  result(): AppliedChange {
    const changed = [...this.changed.values()];
    const putTasks = [...this.touched].map((id) => this.require(id));
    const putDependencies = [...this.putEdges.values()];
    const deleteDependencies = [...this.deletedEdges.values()];
    const event = this.event(putTasks);
    return {
      changed,
      tasks: changed.map((item) => this.require(item.id)),
      write: {
        ...(putTasks.length > 0 ? { putTasks } : {}),
        ...(putDependencies.length > 0 ? { putDependencies } : {}),
        ...(deleteDependencies.length > 0 ? { deleteDependencies } : {}),
        ...(event === undefined ? {} : { event }),
      },
    };
  }

  /**
   * The net change against the snapshot the batch began from: each task put,
   * once, and only the edges that exist now and did not, or the reverse.
   */
  private event(putTasks: readonly Task[]): TaskEvent | undefined {
    const before = new Map(this.original.tasks.map((task) => [task.id, task]));
    const existed = new Set(this.original.dependencies.map(edgeKey));
    const tasks = putTasks.map(
      (task): TaskDelta => ({
        after: task,
        before: before.get(task.id) ?? null,
        id: task.id,
      })
    );
    const added = [...this.putEdges.values()].filter(
      (edge) => !existed.has(edgeKey(edge))
    );
    const removed = [...this.deletedEdges.values()].filter((edge) =>
      existed.has(edgeKey(edge))
    );
    return changeEvent(tasks, added, removed);
  }

  private create(operation: Operation<"task.create">): void {
    const { key, input } = operation;
    if (this.keys.has(key)) {
      throw new TaskError("invalid_operation", `duplicate batch key "${key}"`);
    }
    const id = input.id === undefined ? this.freshId() : taskId(input.id);
    if (this.tasks.has(id)) {
      throw new TaskError("conflict", `Task ${id} already exists`);
    }
    const parentId =
      operation.parent === undefined ? null : this.resolve(operation.parent).id;
    const status = input.status ?? "open";
    const now = this.now();
    this.keys.set(key, id);
    this.put({
      createdAt: now,
      description: input.description ?? null,
      id,
      metadata: input.metadata ?? {},
      parentId,
      settledAt: isSettled(status) ? now : null,
      status,
      tags: uniqueTags(input.tags ?? []),
      title: requireTitle(input.title),
      updatedAt: now,
    });
    this.changed.set(id, { id, key });
    if (parentId !== null) {
      this.note(parentId);
    }
  }

  private update(operation: Operation<"task.update">): void {
    const current = this.target(operation.task, operation);
    const { patch } = operation;
    this.put({
      ...current,
      ...(patch.title === undefined
        ? {}
        : { title: requireTitle(patch.title) }),
      ...(patch.description === undefined
        ? {}
        : { description: patch.description }),
      ...(patch.metadata === undefined ? {} : { metadata: patch.metadata }),
      ...(patch.tags === undefined ? {} : { tags: uniqueTags(patch.tags) }),
      updatedAt: this.now(),
    });
  }

  private setStatus(operation: Operation<"task.set_status">): void {
    const current = this.target(operation.task, operation);
    const { status } = operation;
    if (current.status === status) {
      this.note(current.id);
      return;
    }
    if (isSettled(current.status) && isSettled(status)) {
      throw new TaskError(
        "invalid_status",
        `Task ${current.id} is already ${current.status}; reopen it before marking it ${status}`
      );
    }
    const now = this.now();
    this.put({
      ...current,
      settledAt: isSettled(status) ? now : null,
      status,
      updatedAt: now,
    });
  }

  private move(operation: Operation<"task.move">): void {
    const current = this.target(operation.task, operation);
    const parentId =
      operation.parent === null ? null : this.resolve(operation.parent).id;
    if (parentId !== null && this.isSelfOrDescendant(current.id, parentId)) {
      throw new TaskError(
        "invalid_placement",
        `Task ${current.id} cannot be placed under itself or a descendant`
      );
    }
    if (parentId === current.parentId) {
      this.note(current.id);
    } else {
      this.put({ ...current, parentId, updatedAt: this.now() });
    }
    if (parentId !== null) {
      this.note(parentId);
    }
  }

  private addDependency(operation: Operation<"dependency.add">): void {
    const task = this.resolve(operation.task);
    const dependsOn = this.resolve(operation.dependsOn);
    if (task.id === dependsOn.id) {
      throw new TaskError("cycle", `Task ${task.id} cannot depend on itself`);
    }
    const edge: TaskDependency = { dependsOnId: dependsOn.id, taskId: task.id };
    const key = edgeKey(edge);
    if (this.edges.has(key)) {
      throw new TaskError(
        "conflict",
        `Task ${task.id} already depends on ${dependsOn.id}`
      );
    }
    if (this.reaches(dependsOn.id, task.id)) {
      throw new TaskError(
        "cycle",
        `dependency ${task.id} -> ${dependsOn.id} would close a cycle`
      );
    }
    this.edges.set(key, edge);
    this.putEdges.set(key, edge);
    this.deletedEdges.delete(key);
    this.note(task.id);
    this.note(dependsOn.id);
  }

  private removeDependency(operation: Operation<"dependency.remove">): void {
    const task = this.resolve(operation.task);
    const dependsOn = this.resolve(operation.dependsOn);
    const edge: TaskDependency = { dependsOnId: dependsOn.id, taskId: task.id };
    const key = edgeKey(edge);
    if (!this.edges.has(key)) {
      throw new TaskError(
        "not_found",
        `Task ${task.id} does not depend on ${dependsOn.id}`
      );
    }
    this.edges.delete(key);
    this.putEdges.delete(key);
    this.deletedEdges.set(key, edge);
    this.note(task.id);
    this.note(dependsOn.id);
  }

  /** The task an operation acts on, after its optimistic token is checked. */
  private target(ref: TaskRef, token: TaskToken): Task {
    const task = this.resolve(ref);
    if (
      token.expectedUpdatedAt !== undefined &&
      token.expectedUpdatedAt !== task.updatedAt
    ) {
      throw new TaskError(
        "conflict",
        `Task ${task.id} changed at ${task.updatedAt}, expected ${token.expectedUpdatedAt}`
      );
    }
    return task;
  }

  private resolve(ref: TaskRef): Task {
    if ("key" in ref) {
      const id = this.keys.get(ref.key);
      if (id === undefined) {
        throw new TaskError(
          "invalid_operation",
          `unknown batch key "${ref.key}"`
        );
      }
      return this.require(id);
    }
    return this.require(taskId(ref.id));
  }

  private require(id: TaskId): Task {
    const task = this.tasks.get(id);
    if (task === undefined) {
      throw new TaskError("not_found", `Task ${id} not found`);
    }
    return task;
  }

  private put(task: Task): void {
    this.tasks.set(task.id, task);
    this.touched.add(task.id);
    this.note(task.id);
  }

  private note(id: TaskId): void {
    if (!this.changed.has(id)) {
      this.changed.set(id, { id });
    }
  }

  private freshId(): TaskId {
    for (;;) {
      const hex = crypto.randomUUID().replace(UUID_DASHES, "");
      const id = taskId(`${ID_PREFIX}${hex.slice(0, ID_HEX_LENGTH)}`);
      if (!this.tasks.has(id)) {
        return id;
      }
    }
  }

  /** True when `candidate` is `id` or sits anywhere beneath it. */
  private isSelfOrDescendant(id: TaskId, candidate: TaskId): boolean {
    const seen = new Set<TaskId>();
    let current: TaskId | null = candidate;
    while (current !== null && !seen.has(current)) {
      if (current === id) {
        return true;
      }
      seen.add(current);
      current = this.tasks.get(current)?.parentId ?? null;
    }
    return false;
  }

  /** True when `from` already reaches `to` along depends-on edges. */
  private reaches(from: TaskId, to: TaskId): boolean {
    const next = new Map<TaskId, TaskId[]>();
    for (const edge of this.edges.values()) {
      const targets = next.get(edge.taskId) ?? [];
      targets.push(edge.dependsOnId);
      next.set(edge.taskId, targets);
    }
    const queue = [from];
    const seen = new Set<TaskId>(queue);
    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined) {
        break;
      }
      if (current === to) {
        return true;
      }
      for (const target of next.get(current) ?? []) {
        if (!seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
    return false;
  }
}

/**
 * A `tasks.changed` event over these deltas and edges, or nothing when the
 * write changes nothing.
 */
export function changeEvent(
  tasks: readonly TaskDelta[],
  added: readonly TaskDependency[],
  removed: readonly TaskDependency[]
): TaskEvent | undefined {
  if (tasks.length === 0 && added.length === 0 && removed.length === 0) {
    return;
  }
  return { dependencies: { added, removed }, kind: "tasks.changed", tasks };
}

/** Each tag once, where it first appears. Tags are exact strings. */
function uniqueTags(tags: readonly string[]): readonly string[] {
  return [...new Set(tags)];
}

function requireTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw new TaskError("invalid_operation", "title must not be blank");
  }
  return trimmed;
}
