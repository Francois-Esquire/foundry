import { and, asc, eq } from "drizzle-orm";
import { asBusy } from "~/database/busy";
import { marblesAutomations } from "~/database/tables";
import type { StoreDatabase } from "~/database/types";
import type { AutomationRecord } from "~/lib/automation";
import type {
  AutomationStore,
  AutomationView,
  StoredAutomation,
} from "~/lib/automation/store";
import { storedAutomation } from "~/lib/automation/store";
import { RecordsGate } from "~/lib/events/records-gate";

export interface DatabaseAutomationStoreOptions {
  readonly database: StoreDatabase;
  readonly scope: string;
}

export class DatabaseAutomationStore implements AutomationStore {
  readonly #database: StoreDatabase;
  readonly #scope: string;
  readonly #gate = new RecordsGate("the automation store is closed");

  constructor(options: DatabaseAutomationStoreOptions) {
    this.#database = options.database;
    this.#scope = options.scope;
  }

  close(): Promise<void> {
    return this.#gate.close();
  }

  edit<T>(work: (view: AutomationView) => Promise<T>): Promise<T> {
    return this.#call(() =>
      this.#database.transaction((transaction) =>
        work(automationsIn(transaction, this.#scope))
      )
    );
  }

  list(): Promise<readonly StoredAutomation[]> {
    return this.#call(() => automationsIn(this.#database, this.#scope).list());
  }

  put(record: AutomationRecord): Promise<void> {
    let row: AutomationRow;
    try {
      row = rowOf(record, this.#scope);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#call(() => putRow(this.#database, row));
  }

  remove(id: string): Promise<void> {
    return this.#call(() =>
      automationsIn(this.#database, this.#scope).remove(id)
    );
  }

  #call<T>(call: () => Promise<T>): Promise<T> {
    return this.#gate.run(() => asBusy(call));
  }
}

type AutomationRow = typeof marblesAutomations.$inferInsert;

function automationsIn(database: StoreDatabase, scope: string): AutomationView {
  return {
    async list() {
      const rows = await database
        .select()
        .from(marblesAutomations)
        .where(eq(marblesAutomations.scope, scope))
        .orderBy(asc(marblesAutomations.id));
      return rows.map((row) => ({ id: row.id, value: recordOf(row) }));
    },
    async put(record) {
      await putRow(database, rowOf(record, scope));
    },
    async remove(id) {
      await database
        .delete(marblesAutomations)
        .where(
          and(
            eq(marblesAutomations.scope, scope),
            eq(marblesAutomations.id, id)
          )
        );
    },
  };
}

async function putRow(database: StoreDatabase, row: AutomationRow) {
  const { id: _id, scope: _scope, ...fields } = row;
  await database
    .insert(marblesAutomations)
    .values(row)
    .onConflictDoUpdate({
      set: fields,
      target: [marblesAutomations.scope, marblesAutomations.id],
    });
}

function rowOf(record: AutomationRecord, scope: string): AutomationRow {
  const copy = storedAutomation(record);
  return {
    agentId: copy.owner.agentId,
    at: copy.at,
    createdAt: copy.createdAt,
    enabled: copy.enabled,
    id: copy.id,
    input: copy.input === undefined ? null : JSON.stringify(copy.input),
    key: copy.key,
    ownerDefinition: copy.owner.source.definition,
    ownerPath: copy.owner.source.path,
    ownerRunId: copy.owner.source.runId,
    scope,
    sessionId: copy.owner.sessionId,
    source: copy.source ?? null,
    version: copy.version,
    workflow: copy.workflow,
  };
}

function recordOf(row: typeof marblesAutomations.$inferSelect): unknown {
  return {
    at: row.at,
    createdAt: row.createdAt,
    enabled: row.enabled,
    id: row.id,
    ...(row.input === null ? {} : { input: parsedInput(row.input) }),
    key: row.key,
    owner: {
      agentId: row.agentId,
      sessionId: row.sessionId,
      source: {
        definition: row.ownerDefinition,
        path: row.ownerPath,
        runId: row.ownerRunId,
      },
    },
    ...(row.source === null ? {} : { source: row.source }),
    version: row.version,
    workflow: row.workflow,
  };
}

function parsedInput(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
