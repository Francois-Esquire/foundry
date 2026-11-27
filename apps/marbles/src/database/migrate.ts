import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Client } from "@libsql/client";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  applyMigrations,
  schemaState as coreSchemaState,
  type SchemaState,
  type ShippedMigration,
} from "~/database/migrate-core";
import { BUNDLED_MIGRATIONS } from "~/database/migrations/bundled";
import type { StoreDatabase } from "~/database/types";

export type { SchemaState, ShippedMigration } from "~/database/migrate-core";
// biome-ignore lint/performance/noBarrelFile: Node migration entry point keeps the error its existing callers catch.
export { IncompatibleDatabaseError } from "~/database/migrate-core";

export const MIGRATIONS = fileURLToPath(
  new URL("./migrations", import.meta.url)
);

export function shippedMigrations(
  folder: string = MIGRATIONS
): readonly ShippedMigration[] {
  if (folder === MIGRATIONS) {
    return BUNDLED_MIGRATIONS;
  }
  const journal = JSON.parse(
    readFileSync(join(folder, "meta", "_journal.json"), "utf8")
  ) as { readonly entries: readonly { readonly tag: string }[] };
  return readMigrationFiles({ migrationsFolder: folder }).map(
    (migration, index) => ({
      hash: migration.hash,
      sql: migration.sql,
      tag: journal.entries[index]?.tag ?? String(index),
      when: migration.folderMillis,
    })
  );
}

export function schemaState(
  database: StoreDatabase,
  shipped: readonly ShippedMigration[],
  file: string
): Promise<SchemaState> {
  return coreSchemaState(database, shipped, file);
}

export function migrate(
  client: Client,
  database: StoreDatabase,
  file: string,
  folder: string = MIGRATIONS
): Promise<void> {
  return applyMigrations(database, {
    file,
    foreignKeys: async (enabled) => {
      await client.execute(`PRAGMA foreign_keys = ${enabled ? "ON" : "OFF"}`);
    },
    shipped: shippedMigrations(folder),
  });
}
