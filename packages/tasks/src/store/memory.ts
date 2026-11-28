import { ownedWrite } from "@foundry/lib/plain-json";
import { Turns } from "@foundry/lib/turns";
import type {
  Task,
  TaskDependency,
  TaskId,
  TaskSnapshot,
  TaskStoreWrite,
} from "../schema";
import { edgeKey } from "../schema";
import type { TaskStore, TaskStoreListQuery } from "./index";

const REENTRY =
  "MemoryTaskStore was called from inside its own transaction; use the view passed to the transaction's work instead";

export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<TaskId, Task>();
  private readonly dependencies = new Map<string, TaskDependency>();
  private readonly turns = new Turns(REENTRY);

  commit(write: TaskStoreWrite): Promise<void> {
    let owned: TaskStoreWrite;
    try {
      owned = ownedWrite(write);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.turns.run(() => {
      this.apply(owned);
      return Promise.resolve();
    });
  }

  transaction<T>(work: (view: TaskStore) => Promise<T>): Promise<T> {
    return this.turns.run(async () => {
      const draft = this.draft();
      const result = await work(draft);
      this.adopt(draft);
      return result;
    });
  }

  get(id: TaskId): Promise<Task | null> {
    return this.turns.run(() => {
      const task = this.tasks.get(id);
      return Promise.resolve(task ? structuredClone(task) : null);
    });
  }

  list(query: TaskStoreListQuery = {}): Promise<readonly Task[]> {
    return this.turns.run(() =>
      Promise.resolve(
        [...this.tasks.values()]
          .filter(
            (task) =>
              (query.status === undefined || task.status === query.status) &&
              (query.parentId === undefined || task.parentId === query.parentId)
          )
          .map((task) => structuredClone(task))
      )
    );
  }

  children(parentId: TaskId): Promise<readonly Task[]> {
    return this.list({ parentId });
  }

  dependenciesOf(ids: readonly TaskId[]): Promise<readonly TaskDependency[]> {
    return this.turns.run(() => {
      if (ids.length === 0) {
        return Promise.resolve([]);
      }
      const wanted = new Set(ids);
      return Promise.resolve(
        [...this.dependencies.values()]
          .filter(
            (edge) => wanted.has(edge.taskId) || wanted.has(edge.dependsOnId)
          )
          .map((edge) => ({ ...edge }))
      );
    });
  }

  snapshot(): Promise<TaskSnapshot> {
    return this.turns.run(() =>
      Promise.resolve({
        dependencies: [...this.dependencies.values()].map((edge) => ({
          ...edge,
        })),
        tasks: [...this.tasks.values()].map((task) => structuredClone(task)),
      })
    );
  }

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
    for (const id of write.deleteTasks ?? []) {
      this.tasks.delete(id);
    }
    for (const edge of write.deleteDependencies ?? []) {
      this.dependencies.delete(edgeKey(edge));
    }
    for (const task of write.putTasks ?? []) {
      this.tasks.set(task.id, task);
    }
    for (const edge of write.putDependencies ?? []) {
      this.dependencies.set(edgeKey(edge), edge);
    }
  }
}

function replaceEntries<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>) {
  const entries = [...source];
  target.clear();
  for (const [key, value] of entries) {
    target.set(key, value);
  }
}
