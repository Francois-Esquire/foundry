import { fileURLToPath } from "node:url";

import type { Client } from "@libsql/client";
import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { readMigrationFiles } from "drizzle-orm/migrator";

/**
 * The migrations `drizzle-kit generate` writes from `schema.ts`, committed
 * beside this module. The build copies the folder to `dist/migrations`, next
 * to the chunk this module is bundled into, so the same relative URL finds
 * it in the source tree and in the published package.
 */
export const MIGRATIONS = fileURLToPath(
  new URL("./migrations", import.meta.url)
);

/** The table and columns `drizzle-kit` itself records applied migrations in. */
const APPLIED = "__drizzle_migrations";

/**
 * Bring the database up to the newest migration in `folder`. Drizzle's own
 * libSQL migrator reads what was applied before its transaction opens, so
 * two processes opening a new file at once would both apply everything.
 * Here the read and the writes share one write transaction (`BEGIN
 * IMMEDIATE`), so the second process waits and then finds nothing to do.
 *
 * Foreign keys are off while it runs, as `drizzle-kit`'s table rebuilds
 * need, and a violation they leave behind fails the whole migration. A
 * database migrated by a newer Marbles is refused rather than written to.
 */
export async function migrate(
  client: Client,
  database: LibSQLDatabase,
  folder: string = MIGRATIONS
): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  const newest = migrations.at(-1)?.folderMillis ?? 0;
  await client.execute("PRAGMA foreign_keys = OFF");
  try {
    await database.transaction(async (tx) => {
      await tx.run(
        sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(APPLIED)} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`
      );
      const [last] = await tx.values<[number]>(
        sql`SELECT created_at FROM ${sql.identifier(APPLIED)} ORDER BY created_at DESC LIMIT 1`
      );
      const applied = Number(last?.[0] ?? 0);
      if (applied > newest) {
        throw new Error(
          "the Marbles database was migrated by a newer Marbles; upgrade this one to open it"
        );
      }
      for (const migration of migrations) {
        if (migration.folderMillis <= applied) {
          continue;
        }
        for (const statement of migration.sql) {
          await tx.run(sql.raw(statement));
        }
        await tx.run(
          sql`INSERT INTO ${sql.identifier(APPLIED)} (hash, created_at) VALUES (${migration.hash}, ${migration.folderMillis})`
        );
      }
      const violations = await tx.values(sql`PRAGMA foreign_key_check`);
      if (violations.length > 0) {
        throw new Error(
          `migrating the Marbles database left ${String(violations.length)} foreign key violation(s)`
        );
      }
    });
  } finally {
    await client.execute("PRAGMA foreign_keys = ON");
  }
}
