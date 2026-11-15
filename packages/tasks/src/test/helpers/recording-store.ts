import type { TaskEvent } from "../../schema";
import type { TaskStore, TaskStoreWrite } from "../../store/index";
import { MemoryTaskStore } from "../../store/memory";

/**
 * A memory store that keeps a copy of every write it is handed, whether
 * committed directly or through a transaction's view.
 */
export class RecordingStore implements TaskStore {
  readonly writes: TaskStoreWrite[] = [];
  readonly #inner = new MemoryTaskStore();

  commit(write: TaskStoreWrite): Promise<void> {
    return this.#recorded(this.#inner, write);
  }

  get(id: Parameters<TaskStore["get"]>[0]) {
    return this.#inner.get(id);
  }

  snapshot() {
    return this.#inner.snapshot();
  }

  transaction<T>(work: (view: TaskStore) => Promise<T>): Promise<T> {
    return this.#inner.transaction((view) =>
      work({
        commit: (write) => this.#recorded(view, write),
        get: (id) => view.get(id),
        snapshot: () => view.snapshot(),
      })
    );
  }

  events(): TaskEvent[] {
    return this.writes.flatMap((write) => write.events ?? []);
  }

  #recorded(store: TaskStore, write: TaskStoreWrite): Promise<void> {
    this.writes.push(structuredClone(write));
    return store.commit(write);
  }
}
