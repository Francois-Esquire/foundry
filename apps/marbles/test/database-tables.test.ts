import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentMessages, agentSessions } from "@foundry/agents/store/tables";
import { createTables } from "@foundry/lib/testing/sqlite";
import { Tasks } from "@foundry/tasks";
import { taskDependencies, tasks } from "@foundry/tasks/store/tables";
import type { Client, InArgs } from "@libsql/client";
import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import type { StoreDatabase } from "~/database/open";
import { initializeDatabase } from "~/database/open";
import { pendingChanges } from "~/database/tasks";
import { testMachine } from "./helpers/records";

/**
 * A package's tests stand its tables up from the Drizzle definitions
 * (`@foundry/lib/testing/sqlite`); the real database gets them from the
 * migrations Marbles commits. The two must be the same tables, or the
 * package's tests prove nothing about the database Marbles runs on.
 */

/** The package tables Marbles' migrations create. */
const PACKAGE_TABLES: readonly SQLiteTable[] = [
  agentMessages,
  agentSessions,
  tasks,
  taskDependencies,
];

/** Every column, index and indexed column of `table`, as SQLite reports them. */
async function shape(database: StoreDatabase, table: string) {
  const columns = await database.all(
    sql.raw(`PRAGMA table_xinfo(${JSON.stringify(table)})`)
  );
  const indexes = await database.all<{ name: string }>(
    sql.raw(`PRAGMA index_list(${JSON.stringify(table)})`)
  );
  const indexed = await Promise.all(
    indexes.map(async (index) => ({
      columns: await database.all(
        sql.raw(`PRAGMA index_xinfo(${JSON.stringify(index.name)})`)
      ),
      index,
    }))
  );
  return {
    columns,
    indexes: indexed.sort((a, b) => a.index.name.localeCompare(b.index.name)),
  };
}

describe("the package tables in the Marbles database", () => {
  it("are created by the migrations exactly as the package's tests create them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marbles-tables-"));
    const migrated = await initializeDatabase(join(dir, "marbles.db"));
    const client = createClient({ url: `file:${join(dir, "defined.db")}` });
    try {
      const defined = drizzle({ client });
      await createTables(defined, PACKAGE_TABLES);
      for (const table of PACKAGE_TABLES) {
        const { name } = getTableConfig(table);
        const expected = await shape(defined, name);
        expect(expected.columns.length, name).toBeGreaterThan(0);
        expect(expected.indexes.length, name).toBeGreaterThan(0);
        expect(await shape(migrated.database, name), name).toEqual(expected);
      }
    } finally {
      client.close();
      migrated.close();
    }
  });
});

describe("the read of what is left to deliver", () => {
  it("walks one workspace's changes by position and probes completions by key, scanning nothing", async () => {
    const machine = await testMachine();
    try {
      const { sql: text, params } = pendingChanges(
        machine.database.database,
        "ws",
        { after: 10, handlers: ["a", "b"], limit: 100 }
      ).toSQL();
      // Bound as the query binds them, on the handle's own connection.
      const { $client: client } = machine.database.database as unknown as {
        readonly $client: Client;
      };
      const plan = await client.execute({
        args: params as InArgs,
        sql: `EXPLAIN QUERY PLAN ${text}`,
      });
      const details = plan.rows.map((row) => String(row.detail));
      expect(details).toContain(
        "SEARCH marbles_task_changes USING INDEX marbles_task_changes_scope_position (scope=? AND position>?)"
      );
      expect(
        details.filter((detail) =>
          detail.startsWith(
            "SEARCH marbles_task_change_deliveries USING COVERING INDEX sqlite_autoindex_marbles_task_change_deliveries_1 (scope=? AND change_id=? AND handler=?)"
          )
        )
      ).toHaveLength(2);
      expect(details.filter((detail) => detail.includes("SCAN"))).toEqual([]);
      expect(
        details.filter((detail) => detail.includes("TEMP B-TREE"))
      ).toEqual([]);
    } finally {
      machine.close();
    }
  });

  it("returns only changes a handler has not completed, a batch at a time, and the whole history to a new one", async () => {
    const machine = await testMachine();
    try {
      const state = machine.workspace();
      const records = machine.records(state);
      const backlog = new Tasks({ store: records.taskStore });
      for (let index = 0; index < 250; index += 1) {
        await backlog.create({ title: `T${String(index)}` });
      }
      const first = await records.pending({ handlers: ["done"], limit: 100 });
      expect(first.map((item) => item.position)).toEqual(
        Array.from({ length: 100 }, (_, index) => index + 1)
      );
      for (const item of first) {
        await records.deliver(item.id, "done");
      }
      const next = await records.pending({ handlers: ["done"], limit: 100 });
      expect(next[0]?.position).toBe(101);
      const after = await records.pending({
        after: 240,
        handlers: ["done"],
        limit: 100,
      });
      expect(after.map((item) => item.position)).toEqual([
        241, 242, 243, 244, 245, 246, 247, 248, 249, 250,
      ]);
      // A handler declared later is handed every change from the first.
      const late = await records.pending({
        handlers: ["done", "late"],
        limit: 100,
      });
      expect(late[0]).toMatchObject({ delivered: ["done"], position: 1 });
      expect(await records.latest()).toBe(250);
      await records.close();
    } finally {
      machine.close();
    }
  });
});
