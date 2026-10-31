import { edgeKey } from "./edges";
import type { Task, TaskDependency, TaskEvent, TaskId } from "./types";

/** Everything the store holds; the package resolves the graph over it. */
export interface TaskSnapshot {
  readonly dependencies: readonly TaskDependency[];
  readonly tasks: readonly Task[];
}

/** One atomic write. Deletes apply before puts. */
export interface TaskStoreWrite {
  readonly deleteDependencies?: readonly TaskDependency[];
  readonly deleteTasks?: readonly TaskId[];
  /**
   * What the write changes, present whenever it changes anything. A store
   * that records changes keeps it in the same atomic write; one that does
   * not ignores it.
   */
  readonly event?: TaskEvent;
  readonly putDependencies?: readonly TaskDependency[];
  readonly putTasks?: readonly Task[];
}

/**
 * The persistence seam. A store keeps tasks and dependency edges and applies
 * one write atomically. It enforces nothing: unique ids, acyclic edges,
 * status transitions, and tokens are the package's rules, checked before a
 * write reaches the store. Values crossing this seam are detached.
 */
export interface TaskStore {
  commit: (write: TaskStoreWrite) => Promise<void>;
  get: (id: TaskId) => Promise<Task | null>;
  snapshot: () => Promise<TaskSnapshot>;
  /**
   * Runs one read-modify-write so that no other write to the store lands
   * between its reads and its commit, from any `Tasks` over the store. `work`
   * reads and commits through `view` only. Without it, mutations are
   * serialized per `Tasks` instance and no further.
   */
  transaction?: <T>(work: (view: TaskStore) => Promise<T>) => Promise<T>;
}

/** The default store: plain maps in this process. */
export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<TaskId, Task>();
  private readonly dependencies = new Map<string, TaskDependency>();

  commit(write: TaskStoreWrite): Promise<void> {
    // Clone first so a value that cannot be cloned refuses the whole write.
    const putTasks = (write.putTasks ?? []).map((task): [TaskId, Task] => [
      task.id,
      structuredClone(task),
    ]);
    for (const id of write.deleteTasks ?? []) {
      this.tasks.delete(id);
    }
    for (const edge of write.deleteDependencies ?? []) {
      this.dependencies.delete(edgeKey(edge));
    }
    for (const [id, task] of putTasks) {
      this.tasks.set(id, task);
    }
    for (const edge of write.putDependencies ?? []) {
      this.dependencies.set(edgeKey(edge), { ...edge });
    }
    return Promise.resolve();
  }

  get(id: TaskId): Promise<Task | null> {
    const task = this.tasks.get(id);
    return Promise.resolve(task ? structuredClone(task) : null);
  }

  snapshot(): Promise<TaskSnapshot> {
    return Promise.resolve({
      dependencies: [...this.dependencies.values()].map((edge) => ({
        ...edge,
      })),
      tasks: [...this.tasks.values()].map((task) => structuredClone(task)),
    });
  }
}
