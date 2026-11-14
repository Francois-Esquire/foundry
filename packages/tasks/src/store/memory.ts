import { KeyedQueue } from "@foundry/lib/keyed-queue";
import { edgeKey } from "../edges";
import type {
  Task,
  TaskDependency,
  TaskId,
  TaskSnapshot,
  TaskStoreWrite,
} from "../schema";
import type { TaskStore } from "./index";

/** The one key of a store's turns: the whole store takes them. */
const STORE = "store";

/**
 * The default store: plain maps in this process. Reads list records in the
 * order they were first put; a put over a stored record keeps its place.
 * Commits and transactions take turns, so a commit made while a transaction
 * runs lands after it.
 */
export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<TaskId, Task>();
  private readonly dependencies = new Map<string, TaskDependency>();
  private readonly turns = new KeyedQueue();

  commit(write: TaskStoreWrite): Promise<void> {
    return this.turns.run(STORE, () => {
      this.apply(write);
      return Promise.resolve();
    });
  }

  /**
   * Runs `work` over a draft of the store and keeps the draft only if `work`
   * succeeds, so a throw after a commit through `view` leaves nothing.
   */
  transaction<T>(work: (view: TaskStore) => Promise<T>): Promise<T> {
    return this.turns.run(STORE, async () => {
      const draft = this.draft();
      const result = await work(draft);
      this.adopt(draft);
      return result;
    });
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

  /** A store holding what this one holds; records are never changed in place. */
  private draft(): MemoryTaskStore {
    const draft = new MemoryTaskStore();
    replaceEntries(draft.tasks, this.tasks);
    replaceEntries(draft.dependencies, this.dependencies);
    return draft;
  }

  private adopt(draft: MemoryTaskStore): void {
    replaceEntries(this.tasks, draft.tasks);
    replaceEntries(this.dependencies, draft.dependencies);
  }

  private apply(write: TaskStoreWrite): void {
    // Copy first so a value that cannot be copied refuses the whole write.
    const putTasks = (write.putTasks ?? []).map((task): [TaskId, Task] => [
      task.id,
      structuredClone(task),
    ]);
    const putDependencies = (write.putDependencies ?? []).map(
      (edge): [string, TaskDependency] => [edgeKey(edge), { ...edge }]
    );
    for (const id of write.deleteTasks ?? []) {
      this.tasks.delete(id);
    }
    for (const edge of write.deleteDependencies ?? []) {
      this.dependencies.delete(edgeKey(edge));
    }
    for (const [id, task] of putTasks) {
      this.tasks.set(id, task);
    }
    for (const [key, edge] of putDependencies) {
      this.dependencies.set(key, edge);
    }
  }
}

/** Makes `target` hold `source`'s entries, in `source`'s order. */
function replaceEntries<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>) {
  const entries = [...source];
  target.clear();
  for (const [key, value] of entries) {
    target.set(key, value);
  }
}
