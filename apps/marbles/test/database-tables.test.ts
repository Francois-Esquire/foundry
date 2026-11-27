import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTables } from "@foundry/lib/testing/sqlite";
import type { Client, InArgs } from "@libsql/client";
import { createClient } from "@libsql/client";
import { is, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { changesAfter } from "~/database/changes";
import type { StoreDatabase } from "~/database/open";
import { initializeDatabase } from "~/database/open";
// biome-ignore lint/performance/noNamespaceImport: the test reads every table the schema composes, whatever it is named.
import * as schema from "~/database/schema";
// biome-ignore lint/performance/noNamespaceImport: as above, for Marbles' own tables.
import * as own from "~/database/tables";
import { testMachine } from "./helpers/records";

const OWN_TABLES: readonly unknown[] = Object.values(own);
const PACKAGE_TABLES: readonly SQLiteTable[] = (
  Object.values(schema) as unknown[]
).filter(
  (value): value is SQLiteTable =>
    is(value, SQLiteTable) && !OWN_TABLES.includes(value)
);

const COMPOSED = [
  "agent_messages",
  "agent_sessions",
  "artifact_blob_chunks",
  "artifact_blobs",
  "artifact_content_blobs",
  "artifact_contents",
  "artifacts",
  "authorization_claims",
  "authorization_grants",
  "authorization_restrictions",
  "queue_jobs",
  "queue_pools",
  "queue_runs",
  "queue_suspensions",
  "queue_watermarks",
  "sandbox_containers",
  "scheduling_cursors",
  "scheduling_occurrences",
  "scheduling_schedules",
  "task_dependencies",
  "tasks",
  "workspace_entries",
  "workspaces",
];

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
  it("are every table of every package Marbles composes", () => {
    expect(
      PACKAGE_TABLES.map((table) => getTableConfig(table).name).sort()
    ).toEqual(COMPOSED);
  });

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
  it("walks one workspace's facts of one source by position, scanning nothing", async () => {
    const machine = await testMachine();
    try {
      const { sql: text, params } = changesAfter(
        machine.database.database,
        "ws",
        { after: 10, limit: 100, source: "tasks", types: ["tasks.changed"] }
      ).toSQL();
      const { $client: client } = machine.database.database as unknown as {
        readonly $client: Client;
      };
      const plan = await client.execute({
        args: params as InArgs,
        sql: `EXPLAIN QUERY PLAN ${text}`,
      });
      const details = plan.rows.map((row) => String(row.detail));
      expect(details).toEqual([
        "SEARCH marbles_changes USING INDEX marbles_changes_scope_source_position (scope=? AND source=? AND position>?)",
        "LIST SUBQUERY 1",
        "SCAN json_each VIRTUAL TABLE INDEX 1:",
      ]);
    } finally {
      machine.close();
    }
  });
});
