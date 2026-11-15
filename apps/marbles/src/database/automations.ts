import { and, asc, eq } from "drizzle-orm";
import { asBusy } from "~/database/busy";
import type { StoreDatabase } from "~/database/open";
import { readDatabase } from "~/database/open";
import { marblesAutomations } from "~/database/tables";
import { stateDatabase } from "~/layout";
import type { AutomationRecord } from "~/lib/automation/service";
import type {
  AutomationStore,
  AutomationView,
  StoredAutomation,
} from "~/lib/automation/store";
import { RecordsGate } from "~/lib/events/records";

/**
 * A workspace's automations in the Marbles database
 * (`marbles_automations`), scoped by the workspace id, one row per id, each
 * field of the record in a column of its own. An edit is one write
 * transaction, which takes the database's write lock before it reads, so
 * two engines, in this process or another, never edit at once. Every call
 * surfaces a lock waited on too long as a `DatabaseBusyError`.
 */

export interface DatabaseAutomationStoreOptions {
  /** The database the host keeps open, or one of its transactions. */
  readonly database: StoreDatabase;
  /** The workspace id. */
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

/** The automations of `scope` as `database`, or a transaction on it, holds them. */
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

/** The record's row, copied as it stands now. */
function rowOf(record: AutomationRecord, scope: string): AutomationRow {
  const copy = structuredClone(record);
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

/** A row as the record it holds, unchecked: the service reads it through its schema. */
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

/** A stored input's JSON; one that is not JSON reads as itself, which the schema refuses. */
function parsedInput(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The automations of the workspace `scope` in the Marbles database at the
 * state root `state`, for a command that lists triggers without an
 * engine: each list reads the database read only (`readDatabase`), and is
 * empty with no database or nothing migrated into it; every change is
 * refused.
 */
export function readAutomations(state: string, scope: string): AutomationStore {
  const refused = () =>
    Promise.reject(new Error("the automations are read only here"));
  return {
    close: () => Promise.resolve(),
    edit: refused,
    async list() {
      const read = await asBusy(() =>
        readDatabase(stateDatabase(state), (database) =>
          automationsIn(database, scope).list()
        )
      );
      return read ?? [];
    },
    put: refused,
    remove: refused,
  };
}
