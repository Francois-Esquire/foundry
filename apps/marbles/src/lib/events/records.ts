import { ownedWrite } from "@foundry/lib/plain-json";
import type { TaskStore, TaskStoreWrite } from "@foundry/tasks";
import { MemoryTaskStore } from "@foundry/tasks/store/memory";
import type { ChangeLog, RecordedFact } from "~/lib/events/log";
import { MemoryChangeLog } from "~/lib/events/log";
import { sourceKey, TASKS } from "~/lib/events/source";
import { callingRun } from "~/lib/runs/calling";
import { current } from "~/lib/runs/scope";
import { EmitListeners, RecordsGate } from "./records-gate";

export interface WorkspaceRecords extends DeliveryLease {
  close(): Promise<void>;
  readonly log: ChangeLog;
  readonly taskStore: TaskStore;
  watch(listener: () => void): () => void;
}

export interface DeliveryLease {
  claimDelivery(): Promise<string | undefined>;
  releaseDelivery(): Promise<void>;
}

export function causingRun(): string | null {
  return current.getStore()?.scope.id ?? callingRun() ?? null;
}

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

const TASKS_KEY = sourceKey(TASKS) ?? "tasks";

export class MemoryWorkspaceRecords implements WorkspaceRecords {
  readonly taskStore: TaskStore;
  readonly log: ChangeLog;
  readonly #gate = new RecordsGate();
  readonly #listeners = new EmitListeners();

  constructor() {
    const store = new MemoryTaskStore();
    const log = new MemoryChangeLog();
    this.log = gated(log, this.#gate);
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

function gated(log: ChangeLog, gate: RecordsGate): ChangeLog {
  return {
    compact: (bound) => gate.run(() => log.compact(bound)),
    declare: (key, now) => gate.run(() => log.declare(key, now)),
    fail: (key, failure) => gate.run(() => log.fail(key, failure)),
    head: () => gate.run(() => log.head()),
    move: (key, move) => gate.run(() => log.move(key, move)),
    observers: () => gate.run(() => log.observers()),
    read: (query) => gate.run(() => log.read(query)),
    unstick: (key) => gate.run(() => log.unstick(key)),
  };
}
