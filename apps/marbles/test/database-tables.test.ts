import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTables } from "@foundry/lib/testing/sqlite";
import { taskDependencies, tasks } from "@foundry/tasks/store/tables";
import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import type { StoreDatabase } from "~/database/open";
import { initializeDatabase } from "~/database/open";

/**
 * A package's tests stand its tables up from the Drizzle definitions
 * (`@foundry/lib/testing/sqlite`); the real database gets them from the
 * migrations Marbles commits. The two must be the same tables, or the
 * package's tests prove nothing about the database Marbles runs on.
 */

/** The package tables Marbles' migrations create. */
const PACKAGE_TABLES: readonly SQLiteTable[] = [tasks, taskDependencies];

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
