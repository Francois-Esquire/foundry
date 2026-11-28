import { sql } from "drizzle-orm";

import { BUNDLED_MIGRATIONS } from "~/database/migrations/bundled";
import type { StoreDatabase } from "~/database/types";

export const APPLIED = "__drizzle_migrations";

export interface ShippedMigration {
  readonly hash: string;
  readonly sql: readonly string[];
  readonly tag: string;
  readonly when: number;
}

export type SchemaState =
  | { readonly kind: "empty" }
  | { readonly kind: "current" }
  | { readonly kind: "behind"; readonly missing: readonly ShippedMigration[] };

export class IncompatibleDatabaseError extends Error {
  override readonly name = "IncompatibleDatabaseError";
}

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

export interface ApplyMigrationsOptions {
  readonly file?: string;
  readonly foreignKeys?: (enabled: boolean) => Promise<void>;
  readonly shipped?: readonly ShippedMigration[];
}

export async function applyMigrations(
  database: StoreDatabase,
  options: ApplyMigrationsOptions = {}
): Promise<void> {
  const shipped = options.shipped ?? BUNDLED_MIGRATIONS;
  const file = options.file ?? "this store";
  if ((await schemaState(database, shipped, file)).kind === "current") {
    return;
  }
  const foreignKeys =
    options.foreignKeys ?? ((enabled) => pragmaForeignKeys(database, enabled));
  await foreignKeys(false);
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
    await foreignKeys(true);
  }
}

async function pragmaForeignKeys(
  database: StoreDatabase,
  enabled: boolean
): Promise<void> {
  await database.run(
    sql.raw(`PRAGMA foreign_keys = ${enabled ? "ON" : "OFF"}`)
  );
}

interface AppliedMigration {
  readonly hash: string;
  readonly when: number;
}

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
  return rows.map((row) => ({ hash: String(row[0]), when: Number(row[1]) }));
}

function stamp(when: number): string {
  return new Date(when).toISOString();
}
