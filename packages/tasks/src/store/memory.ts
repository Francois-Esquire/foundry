import { ownedWrite } from "@foundry/lib/plain-json";
import { Turns } from "@foundry/lib/turns";
import { edgeKey } from "../edges";
import type {
  Task,
  TaskDependency,
  TaskId,
  TaskSnapshot,
  TaskStoreWrite,
} from "../schema";
import type { TaskStore } from "./index";

/** Why a call from inside the store's own transaction is refused. */
const REENTRY =
  "MemoryTaskStore was called from inside its own transaction; use the view passed to the transaction's work instead";

/**
 * The default store: plain maps in this process. Reads list records in the
 * order they were first put; a put over a stored record keeps its place.
 * Every call takes a turn, so a commit made while a transaction runs lands
 * after it, and a call made from inside a transaction's work is refused.
 */
export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<TaskId, Task>();
  private readonly dependencies = new Map<string, TaskDependency>();
  private readonly turns = new Turns(REENTRY);

  /**
   * Takes the write as it stands now: its events as plain JSON, the rest
   * by one `structuredClone` (`ownedWrite`), made before the commit waits
   * its turn, so a caller changing the write later changes nothing. A
   * write either refuses rejects whole and changes nothing. A transaction's view commits the same way.
   */
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

  /**
   * Runs `work` over a draft of the store and keeps the draft only if `work`
   * succeeds, so a throw after a commit through `view` leaves nothing.
   */
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

  /** Applies `write`, the store's own copy, which its records then hold. */
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

/** Makes `target` hold `source`'s entries, in `source`'s order. */
function replaceEntries<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>) {
  const entries = [...source];
  target.clear();
  for (const [key, value] of entries) {
    target.set(key, value);
  }
}
