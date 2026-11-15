import { ownedWrite } from "@foundry/lib/plain-json";
import type { TaskStore, TaskStoreWrite } from "@foundry/tasks";
import { MemoryTaskStore } from "@foundry/tasks/store/memory";
import type { ChangeLog, RecordedFact } from "~/lib/events/log";
import { MemoryChangeLog } from "~/lib/events/log";
import { sourceKey, TASKS } from "~/lib/events/source";
import { current } from "~/lib/run-scope";

/**
 * A workspace's durable records, as the engine reads and writes them: its
 * tasks, and its change log (`log`), which every store of the workspace
 * writes its change facts to as it commits them, atomically, whether or
 * not anything observes them; delivery (`delivery.ts`) reads them back
 * later, after a restart too.
 *
 * The engine is handed one (`EngineOptions.records`); Marbles hands it the
 * workspace's rows in the Marbles database (`database/tasks.ts`). Without
 * one it keeps them in memory (`MemoryWorkspaceRecords`), which lasts as
 * long as the engine, and only its tasks' facts reach that log.
 */
export interface WorkspaceRecords extends DeliveryLease {
  /** Refuse every later call, once the calls already made have settled; give up a delivery claim still held. */
  close(): Promise<void>;
  /** The workspace's change log. */
  readonly log: ChangeLog;
  /** The tasks, through the `@foundry/tasks` store seam. */
  readonly taskStore: TaskStore;
  /**
   * Call `listener` soon after a commit in this process recorded a fact,
   * never inside the commit; the function returned stops that.
   */
  watch(listener: () => void): () => void;
}

/**
 * Who delivers a workspace's changes: one engine at a time, the one whose
 * claim was granted, until it gives it up or its process is gone. The one
 * seam a lease of another kind replaces.
 */
export interface DeliveryLease {
  /**
   * Make this engine the one that delivers the workspace's changes to its
   * observers, unless another engine is: who that is, for people, then
   * (`pid 1234`), else undefined. Claiming again while holding it is a
   * claim kept.
   */
  claimDelivery(): Promise<string | undefined>;
  /** Stop being the engine that delivers the workspace's changes, if this one is. */
  releaseDelivery(): Promise<void>;
}

/**
 * The run whose work is calling, read when a store is handed a write: the
 * run its facts are recorded as made by. `null` outside any run.
 */
export function causingRun(): string | null {
  return current.getStore()?.scope.id ?? null;
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
 * over, by the rule every task store takes a write by (`ownedWrite`: its
 * events as plain JSON, the rest cloned), so a write a store would refuse
 * is refused here, before anything clones it into one the store accepts;
 * a write the copy refuses rejects without running `work`.
 */
function owning(
  write: TaskStoreWrite,
  work: (owned: TaskStoreWrite) => Promise<void>
): Promise<void> {
  let owned: TaskStoreWrite;
  try {
    owned = ownedWrite(write);
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

const TASKS_KEY = sourceKey(TASKS) ?? "tasks";

/**
 * The records in this process's memory: a `MemoryTaskStore` for the tasks,
 * and a `MemoryChangeLog` their facts are recorded in. A transaction's
 * facts are kept only if it succeeds, as its tasks are.
 */
export class MemoryWorkspaceRecords implements WorkspaceRecords {
  readonly taskStore: TaskStore;
  readonly log: ChangeLog;
  readonly #gate = new RecordsGate();
  readonly #listeners = new EmitListeners();

  constructor() {
    const store = new MemoryTaskStore();
    const log = new MemoryChangeLog();
    this.log = gated(log, this.#gate);
    /**
     * Commit `owned`, then keep its facts in `into`: both from the one
     * copy each `commit` takes when it is called (`owning`), with the run
     * calling then, so a caller changing its write later, while the commit
     * waits its turn or after, changes neither.
     */
    const recorded =
      (target: TaskStore, into: RecordedFact[]) =>
      (owned: TaskStoreWrite): Promise<void> => {
        const runId = causingRun();
        return target.commit(owned).then(() => {
          for (const fact of owned.events ?? []) {
            into.push({
              fact,
              recordedAt: Date.now(),
              runId,
              source: TASKS_KEY,
            });
          }
        });
      };
    const settle = (facts: readonly RecordedFact[]): void => {
      log.record(facts);
      if (facts.length > 0) {
        this.#listeners.emit();
      }
    };
    this.taskStore = {
      commit: (write) =>
        owning(write, (owned) =>
          this.#gate.run(async () => {
            const facts: RecordedFact[] = [];
            await recorded(store, facts)(owned);
            settle(facts);
          })
        ),
      get: (id) => this.#gate.run(() => store.get(id)),
      snapshot: () => this.#gate.run(() => store.snapshot()),
      transaction: (work) =>
        this.#gate.run(async () => {
          const facts: RecordedFact[] = [];
          const result = await store.transaction((view) =>
            work({
              commit: (write) => owning(write, recorded(view, facts)),
              get: (id) => view.get(id),
              snapshot: () => view.snapshot(),
            })
          );
          settle(facts);
          return result;
        }),
    };
  }

  /** Nothing else reads these records, so this engine always delivers them. */
  claimDelivery(): Promise<string | undefined> {
    return this.#gate.run(() => Promise.resolve(undefined));
  }

  close(): Promise<void> {
    return this.#gate.close();
  }

  releaseDelivery(): Promise<void> {
    return this.#gate.run(() => Promise.resolve());
  }

  watch(listener: () => void): () => void {
    return this.#listeners.add(listener);
  }
}

/** `log`, each call refused once `gate` is closed. */
function gated(log: ChangeLog, gate: RecordsGate): ChangeLog {
  return {
    compact: (bound) => gate.run(() => log.compact(bound)),
    declare: (key, now) => gate.run(() => log.declare(key, now)),
    fail: (key, failure) => gate.run(() => log.fail(key, failure)),
    head: () => gate.run(() => log.head()),
    move: (key, move) => gate.run(() => log.move(key, move)),
    observers: () => gate.run(() => log.observers()),
    read: (query) => gate.run(() => log.read(query)),
  };
}
