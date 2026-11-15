import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Marbles' own tables. A workspace's id is the scope every package's rows
 * are partitioned by, so this table, the registry of those ids, has none.
 */

/**
 * Every workspace this machine has run, and whether the Marbles process
 * hosts it. One row per id; `first_seen` is set once, `last_seen` on every
 * sight. Times are ISO strings, as the record holds them.
 */
export const marblesWorkspaces = sqliteTable("marbles_workspaces", {
  config: text(),
  firstSeen: text("first_seen").notNull(),
  hosted: integer({ mode: "boolean" }).notNull().default(false),
  id: text().primaryKey(),
  lastSeen: text("last_seen").notNull(),
  root: text().notNull(),
});
