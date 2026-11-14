import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, test } from "vitest";
import { createTables, tableStatements } from "../testing/sqlite";

const items = sqliteTable(
  "items",
  {
    count: integer("count").notNull(),
    id: text("id").notNull(),
    note: text("note"),
    scope: text("scope").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("items_scope_count").on(table.scope, table.count),
    uniqueIndex("items_scope_note").on(table.scope, table.note),
  ]
);

const clients: ReturnType<typeof createClient>[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close();
  }
});

function database() {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  return drizzle(client);
}

describe("createTables", () => {
  test("creates the columns, primary key, and indexes a definition holds", async () => {
    const db = database();
    await createTables(db, [items]);

    const columns = await db.all<{
      name: string;
      notnull: number;
      pk: number;
      type: string;
    }>(
      sql`SELECT name, type, "notnull", pk FROM pragma_table_info('items') ORDER BY cid`
    );
    expect(columns).toEqual([
      { name: "count", notnull: 1, pk: 0, type: "INTEGER" },
      { name: "id", notnull: 1, pk: 2, type: "TEXT" },
      { name: "note", notnull: 0, pk: 0, type: "TEXT" },
      { name: "scope", notnull: 1, pk: 1, type: "TEXT" },
    ]);
    const indexes = await db.all<{ name: string; unique: number }>(
      sql`SELECT name, "unique" FROM pragma_index_list('items') WHERE origin = 'c' ORDER BY name`
    );
    expect(indexes).toEqual([
      { name: "items_scope_count", unique: 0 },
      { name: "items_scope_note", unique: 1 },
    ]);

    await db.insert(items).values({ count: 1, id: "a", scope: "s" });
    await expect(
      db.insert(items).values({ count: 2, id: "a", scope: "s" })
    ).rejects.toThrow();
  });

  test("refuses what it cannot express, naming it", () => {
    const parents = sqliteTable("parents", { id: text("id").primaryKey() });
    const refusals = [
      sqliteTable("defaulted", { id: text("id").notNull().default("x") }),
      sqliteTable("uniques", { id: text("id").notNull() }, (table) => [
        unique("uniques_id").on(table.id),
      ]),
      sqliteTable("children", { parent: text("parent").notNull() }, (table) => [
        foreignKey({ columns: [table.parent], foreignColumns: [parents.id] }),
      ]),
      sqliteTable("partial", { id: text("id").notNull() }, (table) => [
        index("partial_id").on(table.id).where(sql`${table.id} <> ''`),
      ]),
      parents,
    ];
    for (const table of refusals) {
      expect(() => tableStatements(table)).toThrow("cannot create");
    }
  });
});
