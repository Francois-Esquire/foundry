import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { TaskEvent } from "@foundry/tasks";
import { asc, eq } from "drizzle-orm";
import type { MarblesDatabase } from "~/database/open";
import { initializeDatabase } from "~/database/open";
import {
  marblesTaskChangeDeliveries,
  marblesTaskChanges,
} from "~/database/tables";
import { DatabaseWorkspaceRecords } from "~/database/tasks";
import { stateDatabase } from "~/layout";

/**
 * A state root with a migrated Marbles database, opened in this process as
 * the Marbles process would, and workspace state dirs under it, each the
 * scope of its rows (`<root>/<id>`, id = the dir's name).
 */
export interface TestMachine {
  /** The recorded changes of the workspace at `state`, oldest first. */
  changes(state: string): Promise<readonly RecordedChange[]>;
  close(): void;
  readonly database: MarblesDatabase;
  /** The number of handlers that completed each recorded change, oldest first. */
  deliveredCounts(state: string): Promise<number[]>;
  /** Fresh records for the workspace at `state`, over this machine's database. */
  records(state: string): DatabaseWorkspaceRecords;
  readonly root: string;
  /** A new workspace state dir under the root. */
  workspace(): string;
}

interface RecordedChange {
  readonly delivered: readonly string[];
  readonly id: string;
  readonly payload: TaskEvent;
}

export async function testMachine(): Promise<TestMachine> {
  const root = mkdtempSync(join(tmpdir(), "marbles-machine-"));
  const database = await initializeDatabase(stateDatabase(root));
  const changes = async (state: string): Promise<RecordedChange[]> => {
    const scope = basename(state);
    const rows = await database.database
      .select()
      .from(marblesTaskChanges)
      .where(eq(marblesTaskChanges.scope, scope))
      .orderBy(asc(marblesTaskChanges.position));
    const deliveries = await database.database
      .select()
      .from(marblesTaskChangeDeliveries)
      .where(eq(marblesTaskChangeDeliveries.scope, scope));
    return rows.map((row) => ({
      delivered: deliveries
        .filter((delivery) => delivery.changeId === row.id)
        .map((delivery) => delivery.handler),
      id: row.id,
      payload: row.payload,
    }));
  };
  return {
    changes,
    close: () => database.close(),
    database,
    async deliveredCounts(state) {
      return (await changes(state)).map((change) => change.delivered.length);
    },
    records: (state) =>
      new DatabaseWorkspaceRecords({
        database: database.database,
        scope: basename(state),
      }),
    root,
    workspace() {
      const dir = mkdtempSync(join(root, "ws-"));
      mkdirSync(dir, { recursive: true });
      return dir;
    },
  };
}
