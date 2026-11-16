import { randomUUID } from "node:crypto";
import type { TaskEvent, TaskStore, TaskStoreWrite } from "@foundry/tasks";
import { MemoryTaskStore } from "@foundry/tasks/store/memory";
import { TASKS } from "~/lib/events/source";

export interface WorkspaceRecords {
  close(): Promise<void>;
  deliver(id: string, hash: string): Promise<void>;
  latest(): Promise<number>;
  pending(query: PendingQuery): Promise<readonly StreamItem[]>;
  readonly taskStore: TaskStore;
  watch(listener: () => void): () => void;
}

export interface PendingQuery {
  readonly after?: number;
  readonly handlers: readonly string[];
  readonly limit?: number;
}

export const PENDING_BATCH = 100;

export interface StreamItem {
  readonly delivered: readonly string[];
  readonly id: string;
  readonly payload: unknown;
  readonly position: number;
  readonly source: symbol;
}

const CLOSED = "workspace records are closed";

export class RecordsGate {
  readonly #running = new Set<Promise<unknown>>();
  readonly #refusal: string;
  #phase: "open" | "closed" = "open";

  constructor(refusal = CLOSED) {
    this.#refusal = refusal;
  }

  run<T>(call: () => Promise<T>): Promise<T> {
    if (this.#phase === "closed") {
      return Promise.reject(new Error(this.#refusal));
    }
    const running = call();
    const settled = running.then(
      () => undefined,
      () => undefined
    );
    this.#running.add(settled);
    settled.finally(() => this.#running.delete(settled));
    return running;
  }

  async close(): Promise<void> {
    this.#phase = "closed";
    await Promise.all(this.#running);
  }
}

function owning(
  write: TaskStoreWrite,
  work: (owned: TaskStoreWrite) => Promise<void>
): Promise<void> {
  let owned: TaskStoreWrite;
  try {
    owned = structuredClone(write);
  } catch (error) {
    return Promise.reject(error);
  }
  return work(owned);
}

export class EmitListeners {
  readonly #listeners = new Set<() => void>();

  add(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

interface MemoryChange {
  readonly delivered: string[];
  readonly id: string;
  readonly payload: TaskEvent;
}

export class MemoryWorkspaceRecords implements WorkspaceRecords {
  readonly taskStore: TaskStore;
  readonly #changes: MemoryChange[] = [];
  readonly #gate = new RecordsGate();
  readonly #listeners = new EmitListeners();

  constructor() {
    const store = new MemoryTaskStore();
    const recorded =
      (target: TaskStore, into: TaskEvent[]) =>
      async (owned: TaskStoreWrite): Promise<void> => {
        await target.commit(owned);
        if (owned.event !== undefined) {
          into.push(owned.event);
        }
      };
    const settle = (events: readonly TaskEvent[]): void => {
      for (const payload of events) {
        this.#changes.push({ delivered: [], id: randomUUID(), payload });
      }
      if (events.length > 0) {
        this.#listeners.emit();
      }
    };
    this.taskStore = {
      commit: (write) =>
        owning(write, (owned) =>
          this.#gate.run(async () => {
            const events: TaskEvent[] = [];
            await recorded(store, events)(owned);
            settle(events);
          })
        ),
      get: (id) => this.#gate.run(() => store.get(id)),
      snapshot: () => this.#gate.run(() => store.snapshot()),
      transaction: (work) =>
        this.#gate.run(async () => {
          const events: TaskEvent[] = [];
          const result = await store.transaction((view) =>
            work({
              commit: (write) => owning(write, recorded(view, events)),
              get: (id) => view.get(id),
              snapshot: () => view.snapshot(),
            })
          );
          settle(events);
          return result;
        }),
    };
  }

  close(): Promise<void> {
    return this.#gate.close();
  }

  deliver(id: string, hash: string): Promise<void> {
    return this.#gate.run(() => {
      const change = this.#changes.find((candidate) => candidate.id === id);
      if (change !== undefined && !change.delivered.includes(hash)) {
        change.delivered.push(hash);
      }
      return Promise.resolve();
    });
  }

  latest(): Promise<number> {
    return this.#gate.run(() => Promise.resolve(this.#changes.length));
  }

  pending(query: PendingQuery): Promise<readonly StreamItem[]> {
    const after = query.after ?? 0;
    const limit = query.limit ?? PENDING_BATCH;
    return this.#gate.run(() =>
      Promise.resolve(
        this.#changes
          .map((change, index) => ({ change, position: index + 1 }))
          .filter(
            ({ change, position }) =>
              position > after &&
              query.handlers.some((hash) => !change.delivered.includes(hash))
          )
          .slice(0, limit)
          .map(({ change, position }) => ({
            delivered: change.delivered.filter((hash) =>
              query.handlers.includes(hash)
            ),
            id: change.id,
            payload: structuredClone(change.payload),
            position,
            source: TASKS,
          }))
      )
    );
  }

  watch(listener: () => void): () => void {
    return this.#listeners.add(listener);
  }
}
