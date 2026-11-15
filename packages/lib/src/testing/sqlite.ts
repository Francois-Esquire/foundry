import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { BaseSQLiteDatabase, SQLiteTable } from "drizzle-orm/sqlite-core";
import { getTableConfig, SQLiteColumn } from "drizzle-orm/sqlite-core";

/**
 * Real tables from Drizzle definitions, for tests of a store over SQLite. A
 * host's migrations own the real schema; packages ship none, so their tests
 * stand the tables up from the definitions they ship instead.
 */

/** An async Drizzle SQLite database, with or without a relational schema. */
export type TestDatabase = BaseSQLiteDatabase<
  "async",
  unknown,
  Record<string, unknown>
>;

/** Creates each table, then its indexes, in order. */
export async function createTables(
  database: TestDatabase,
  tables: readonly SQLiteTable[]
): Promise<void> {
  for (const statement of tables.flatMap(tableStatements)) {
    await database.run(statement);
  }
}

/**
 * `CREATE TABLE` and `CREATE INDEX` for one definition. It expresses column
 * types, `NOT NULL`, the primary key, and indexes on plain columns, and
 * throws on anything else the definition holds, so a test never runs on a
 * table that differs from its definition.
 */
export function tableStatements(table: SQLiteTable): SQL[] {
  const config = getTableConfig(table);
  const refused = [
    config.foreignKeys.length > 0 && "foreign keys",
    config.uniqueConstraints.length > 0 && "unique constraints",
    config.checks.length > 0 && "checks",
    ...config.columns.flatMap((column) => [
      column.primary && `a column primary key on ${column.name}`,
      column.hasDefault && `a default on ${column.name}`,
      column.isUnique && `a unique column ${column.name}`,
      column.generated !== undefined && `a generated column ${column.name}`,
    ]),
    ...config.indexes.flatMap(({ config: index }) => [
      index.where !== undefined && `a partial index ${index.name}`,
      !index.columns.every(isColumn) && `an expression index ${index.name}`,
    ]),
  ].filter((reason): reason is string => typeof reason === "string");
  if (refused.length > 0) {
    throw new Error(
      `${config.name}: cannot create ${refused.join(", ")}; only column types, NOT NULL, a primary key, and plain indexes`
    );
  }

  const columns = config.columns.map((column) =>
    [
      quote(column.name),
      column.getSQLType(),
      ...(column.notNull ? ["NOT NULL"] : []),
    ].join(" ")
  );
  const keys = config.primaryKeys.map(
    (key) => `PRIMARY KEY (${names(key.columns)})`
  );
  const indexes = config.indexes.map(
    ({ config: index }) =>
      `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quote(index.name)} ON ${quote(config.name)} (${names(index.columns.filter(isColumn))})`
  );
  return [
    `CREATE TABLE ${quote(config.name)} (${[...columns, ...keys].join(", ")})`,
    ...indexes,
  ].map((statement) => sql.raw(statement));
}

function isColumn(value: unknown): value is SQLiteColumn {
  return value instanceof SQLiteColumn;
}

function names(columns: readonly SQLiteColumn[]): string {
  return columns.map((column) => quote(column.name)).join(", ");
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
