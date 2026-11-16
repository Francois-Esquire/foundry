import { RecordsGate } from "~/lib/events/records";
import { storableJson } from "~/lib/state/json";
import type { AutomationRecord } from "./service";

export interface AutomationStore extends AutomationView {
  close(): Promise<void>;
  edit<T>(work: (view: AutomationView) => Promise<T>): Promise<T>;
}

export interface AutomationView {
  list(): Promise<readonly StoredAutomation[]>;
  put(record: AutomationRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface StoredAutomation {
  readonly id: string;
  readonly value: unknown;
}

export function storedAutomation(record: AutomationRecord): AutomationRecord {
  return storableJson(
    `automation ${JSON.stringify(record.id)}`,
    record
  ) as unknown as AutomationRecord;
}

export class MemoryAutomationStore implements AutomationStore {
  readonly #gate = new RecordsGate("the automation store is closed");
  readonly #records = new Map<string, AutomationRecord>();
  #turn: Promise<unknown> = Promise.resolve();

  close(): Promise<void> {
    return this.#gate.close();
  }

  edit<T>(work: (view: AutomationView) => Promise<T>): Promise<T> {
    return this.#gate.run(() => {
      const editing = this.#turn.then(async () => {
        const draft = new Map(this.#records);
        const result = await work(viewOf(draft));
        this.#records.clear();
        for (const [id, record] of draft) {
          this.#records.set(id, record);
        }
        return result;
      });
      this.#turn = editing.catch(() => undefined);
      return editing;
    });
  }

  list(): Promise<readonly StoredAutomation[]> {
    return this.#gate.run(() => viewOf(this.#records).list());
  }

  put(record: AutomationRecord): Promise<void> {
    let owned: AutomationRecord;
    try {
      owned = storedAutomation(record);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.edit((view) => view.put(owned));
  }

  remove(id: string): Promise<void> {
    return this.edit((view) => view.remove(id));
  }
}

function viewOf(records: Map<string, AutomationRecord>): AutomationView {
  return {
    list: () =>
      Promise.resolve(
        [...records]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, record]) => ({ id, value: structuredClone(record) }))
      ),
    put: (record) => {
      try {
        records.set(record.id, storedAutomation(record));
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    },
    remove: (id) => {
      records.delete(id);
      return Promise.resolve();
    },
  };
}
