import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Client } from "@libsql/client";
import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { readMigrationFiles } from "drizzle-orm/migrator";

import type { StoreDatabase } from "~/database/open";

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
export const APPLIED = "__drizzle_migrations";

/** One migration this Marbles ships, in the order they apply. */
export interface ShippedMigration {
  readonly hash: string;
  readonly sql: readonly string[];
  /** Its name in the journal, `0000_init`. */
  readonly tag: string;
  /** When it was generated, in ms since the epoch: its `created_at` once applied. */
  readonly when: number;
}

/** What a database holds compared with what this Marbles ships. */
export type SchemaState =
  /** No migration was ever applied: nothing is recorded in it. */
  | { readonly kind: "empty" }
  | { readonly kind: "current" }
  /** Applied is a prefix of shipped: `missing` would bring it up to date. */
  | { readonly kind: "behind"; readonly missing: readonly ShippedMigration[] };

/**
 * A database this Marbles cannot use as it is: migrated by a newer Marbles,
 * with a history that differs from the one shipped here, or, for a caller
 * that does not migrate, one that has not been brought up to date yet.
 */
export class IncompatibleDatabaseError extends Error {
  override readonly name = "IncompatibleDatabaseError";
}

/** The migrations in `folder`, with their journal names. */
export function shippedMigrations(
  folder: string = MIGRATIONS
): readonly ShippedMigration[] {
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

/**
 * Where `database` stands against `shipped`. Its applied history must be an
 * exact prefix of the shipped one, timestamps and hashes alike; anything
 * else is refused, naming the first place they part.
 */
export async function schemaState(
  database: StoreDatabase,
  shipped: readonly ShippedMigration[],
  file: string
): Promise<SchemaState> {
  const applied = (await appliedMigrations(database)) ?? [];
  for (const [index, migration] of applied.entries()) {
    const expected = shipped[index];
    if (expected === undefined) {
      throw new IncompatibleDatabaseError(
        `the Marbles database at ${file} has ${String(applied.length - shipped.length)} migration(s) this Marbles does not ship, the first made ${stamp(migration.when)}; it was migrated by a newer Marbles, so upgrade this one to open it`
      );
    }
    if (migration.hash !== expected.hash || migration.when !== expected.when) {
      throw new IncompatibleDatabaseError(
        `the Marbles database at ${file} differs from this Marbles at migration ${String(index + 1)}: it applied one made ${stamp(migration.when)} (hash ${migration.hash.slice(0, 12)}), where this Marbles ships ${expected.tag}, made ${stamp(expected.when)} (hash ${expected.hash.slice(0, 12)})`
      );
    }
  }
  if (applied.length === shipped.length) {
    return { kind: "current" };
  }
  return applied.length === 0
    ? { kind: "empty" }
    : { kind: "behind", missing: shipped.slice(applied.length) };
}

/**
 * Bring the database up to the newest migration in `folder`. A database
 * already there is found with a plain read, so opening it takes no write
 * lock. Otherwise the check and the writes share one write transaction
 * (`BEGIN IMMEDIATE`). Drizzle's own libSQL migrator reads what was applied
 * before its transaction opens, so two processes opening a new file at once
 * would both apply everything; here the second waits, then finds nothing
 * left to do.
 *
 * Foreign keys are off while it writes, as `drizzle-kit`'s table rebuilds
 * need, and a violation they leave behind fails the whole migration. A
 * history that is not a prefix of the shipped one is refused rather than
 * written to (`schemaState`).
 */
export async function migrate(
  client: Client,
  database: LibSQLDatabase,
  file: string,
  folder: string = MIGRATIONS
): Promise<void> {
  const shipped = shippedMigrations(folder);
  if ((await schemaState(database, shipped, file)).kind === "current") {
    return;
  }
  await client.execute("PRAGMA foreign_keys = OFF");
  try {
    await database.transaction(async (tx) => {
      await tx.run(
        sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(APPLIED)} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`
      );
      const state = await schemaState(tx, shipped, file);
      if (state.kind === "current") {
        return;
      }
      for (const migration of state.kind === "empty"
        ? shipped
        : state.missing) {
        for (const statement of migration.sql) {
          await tx.run(sql.raw(statement));
        }
        await tx.run(
          sql`INSERT INTO ${sql.identifier(APPLIED)} (hash, created_at) VALUES (${migration.hash}, ${migration.when})`
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

interface AppliedMigration {
  readonly hash: string;
  readonly when: number;
}

/**
 * Every migration applied to `database`, in the order it applied them;
 * undefined before the first. The `id` column `drizzle-kit` declares is
 * never set, so the row order breaks a tie.
 */
async function appliedMigrations(
  database: StoreDatabase
): Promise<readonly AppliedMigration[] | undefined> {
  const [table] = await database.values(
    sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${APPLIED}`
  );
  if (table === undefined) {
    return;
  }
  const rows = await database.values<[string, number]>(
    sql`SELECT hash, created_at FROM ${sql.identifier(APPLIED)} ORDER BY created_at, rowid`
  );
  // libSQL rows index like arrays but do not iterate.
  return rows.map((row) => ({ hash: String(row[0]), when: Number(row[1]) }));
}

function stamp(when: number): string {
  return new Date(when).toISOString();
}
