import { RecordsGate } from "~/lib/events/records";
import type { AutomationRecord } from "./service";

/**
 * Where a workspace's automations are kept, the triggers agents created,
 * one by id. The store enforces nothing about them: `AutomationService`
 * says what is written, inside `edit` when it reads first, so two engines
 * editing at once never act on what the other is changing.
 * `MemoryAutomationStore` keeps them in this process; the Marbles database
 * keeps them on disk (`database/automations.ts`), shared by every engine
 * over it.
 */
export interface AutomationStore extends AutomationView {
  /** Refuse every call from now on, once those under way have settled. */
  close(): Promise<void>;
  /**
   * `work` over a view of the automations no other edit changes until it
   * settles, by any engine sharing the store; what it put or removed is
   * kept when it resolves, and nothing of it when it rejects.
   */
  edit<T>(work: (view: AutomationView) => Promise<T>): Promise<T>;
}

/** The automations, as a store or an edit in progress sees them. */
export interface AutomationView {
  /**
   * Every automation kept, by id, in id order. A stored value is not
   * trusted: the service reads it through its schema.
   */
  list(): Promise<readonly StoredAutomation[]>;
  /** Keep `record` as its id's, whole. */
  put(record: AutomationRecord): Promise<void>;
  /** Forget the automation `id`; nothing when there is none. */
  remove(id: string): Promise<void>;
}

/** An automation as the store gives it back: its id, and its record unchecked. */
export interface StoredAutomation {
  readonly id: string;
  readonly value: unknown;
}

/**
 * The automations held in this process, for one engine: nothing outlives
 * it. Records are copied in and out, so no caller shares a reference with
 * the store; one edit runs at a time.
 */
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

  /** Taken now, and kept in its turn, after any edit under way. */
  put(record: AutomationRecord): Promise<void> {
    let owned: AutomationRecord;
    try {
      owned = structuredClone(record);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.edit((view) => view.put(owned));
  }

  remove(id: string): Promise<void> {
    return this.edit((view) => view.remove(id));
  }
}

/** A view over `records`, changing them in place. */
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
        records.set(record.id, structuredClone(record));
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
