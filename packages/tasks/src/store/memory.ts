import { edgeKey } from "../edges";
import type {
  Task,
  TaskDependency,
  TaskId,
  TaskSnapshot,
  TaskStoreWrite,
} from "../schema";
import type { TaskStore } from "./index";

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
