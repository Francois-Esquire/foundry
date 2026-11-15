import { randomUUID } from "node:crypto";
import type { TaskEvent, TaskStore, TaskStoreWrite } from "@foundry/tasks";
import { MemoryTaskStore } from "@foundry/tasks/store/memory";
import { TASKS } from "~/lib/events/source";

/**
 * A workspace's durable records, as the engine reads and writes them: its
 * tasks, and every change they committed, each with the hashes of the
 * observers that completed it. A commit through `taskStore` that changes
 * something records its change with it, atomically, whether or not
 * anything observes it; delivery (`delivery.ts`) reads them back later,
 * after a restart too. Nothing removes a change or a recorded hash.
 *
 * The engine is handed one (`EngineOptions.records`); Marbles hands it the
 * workspace's rows in the Marbles database (`database/tasks.ts`). Without
 * one it keeps them in memory (`MemoryWorkspaceRecords`), which lasts as
 * long as the engine.
 */
export interface WorkspaceRecords {
  /** Refuse every later call, once the calls already made have settled. */
  close(): Promise<void>;
  /** Record that the handler with `hash` completed the change `id`, beside every hash already there. */
  deliver(id: string, hash: string): Promise<void>;
  /**
   * The position of the newest recorded change, 0 before the first: a
   * cheap read for noticing a change another process recorded.
   */
  latest(): Promise<number>;
  /**
   * The recorded changes after `query.after` that a handler in
   * `query.handlers` has not completed, oldest first, at most
   * `query.limit`, detached. A handler with no completion yet (one declared
   * later) is handed the whole history this way.
   */
  pending(query: PendingQuery): Promise<readonly StreamItem[]>;
  /** The tasks, through the `@foundry/tasks` store seam. */
  readonly taskStore: TaskStore;
  /**
   * Call `listener` after each call through `taskStore` that recorded a
   * change, once that call has settled, never inside it; the function
   * returned stops that.
   */
  watch(listener: () => void): () => void;
}

/** Which recorded changes `pending` reads. */
export interface PendingQuery {
  /** Only changes after this position; from the first when omitted. */
  readonly after?: number;
  /** The hashes of the handlers that are to complete each change. */
  readonly handlers: readonly string[];
  /** At most this many; `PENDING_BATCH` when omitted. */
  readonly limit?: number;
}

/** How many changes one `pending` read returns by default. */
export const PENDING_BATCH = 100;

/** A recorded change as delivery reads it: detached, with its source resolved. */
export interface StreamItem {
  /** Hashes of the handlers, among those asked about, that completed it. */
  readonly delivered: readonly string[];
  readonly id: string;
  readonly payload: unknown;
  /** Its place among the workspace's changes, in the order they were committed. */
  readonly position: number;
  readonly source: symbol;
}

const CLOSED = "workspace records are closed";

/**
 * Calls that may still be running, and the refusal of new ones once
 * `close` begins, for a `WorkspaceRecords` or any store that closes the
 * same way; `refusal` is what a call made once closed is told.
 */
export class RecordsGate {
  readonly #running = new Set<Promise<unknown>>();
  readonly #refusal: string;
  #phase: "open" | "closed" = "open";

  constructor(refusal = CLOSED) {
    this.#refusal = refusal;
  }

  /** Run `call`, unless the records are closed. */
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

/**
 * Run `work` on a copy of `write` taken now, when the caller hands it
 * over; a write the copy refuses rejects without running `work`.
 */
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

/** Who to tell that a call recorded a change, and the telling. */
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

/**
 * The records in this process's memory: a `MemoryTaskStore` for the tasks,
 * and the changes beside it. A transaction's changes are kept only if it
 * succeeds, as its tasks are.
 */
export class MemoryWorkspaceRecords implements WorkspaceRecords {
  readonly taskStore: TaskStore;
  readonly #changes: MemoryChange[] = [];
  readonly #gate = new RecordsGate();
  readonly #listeners = new EmitListeners();

  constructor() {
    const store = new MemoryTaskStore();
    /**
     * Commit `owned`, then keep its change in `into`: both from the one
     * copy each `commit` takes when it is called (`owning`), so a caller
     * changing its write later, while the commit waits its turn or after,
     * changes neither.
     */
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
