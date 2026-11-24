import type { ExtractTablesWithRelations, SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type {
  BaseSQLiteDatabase,
  SQLiteColumn,
  SQLiteTransaction,
} from "drizzle-orm/sqlite-core";

export type AsyncSQLiteDatabase = BaseSQLiteDatabase<
  "async",
  unknown,
  Record<string, unknown>
>;

export type AsyncSQLiteTransaction = SQLiteTransaction<
  "async",
  unknown,
  Record<string, unknown>,
  ExtractTablesWithRelations<Record<string, unknown>>
>;

export const SQLITE_MAX_PARAMETERS = 32_766;

export const UNSTORABLE_TEXT =
  "text holding U+0000 or a lone surrogate (not well-formed UTF-16) does not read back intact from SQLite";

const UNSTORABLE_TIME =
  "a time that is not a valid Date has no epoch milliseconds to store";

const UNSTORABLE_INTEGER =
  "SQLite keeps an integer column as a safe integer, and reads -0 back as 0";

export function storable(text: unknown): text is string {
  return (
    typeof text === "string" && text.isWellFormed() && !text.includes("\u0000")
  );
}

export function storableNumber(value: number): boolean {
  return !Object.is(value, -0) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

export function describeNumber(value: number): string {
  return Object.is(value, -0) ? "-0" : String(value);
}

export function whyUnstorable(
  value: unknown,
  kind: "integer" | "text" | "time"
): string | undefined {
  switch (kind) {
    case "text":
      return typeof value === "string" && !storable(value)
        ? UNSTORABLE_TEXT
        : undefined;
    case "time":
      return value instanceof Date && !Number.isFinite(value.getTime())
        ? UNSTORABLE_TIME
        : undefined;
    default:
      return typeof value === "number" &&
        (!Number.isSafeInteger(value) || Object.is(value, -0))
        ? UNSTORABLE_INTEGER
        : undefined;
  }
}

export function assertScope(scope: string): void {
  if (scope.length === 0 || !storable(scope)) {
    throw new RangeError(
      "scope must be a nonempty string with no U+0000 and no lone surrogate"
    );
  }
}

export function batches<T>(items: readonly T[], size: number): T[][] {
  const length = Math.max(1, Math.floor(size));
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += length) {
    result.push(items.slice(start, start + length));
  }
  return result;
}

export function excluded(column: SQLiteColumn): SQL {
  return sql.raw(`excluded."${column.name}"`);
}

export function replacing(
  columns: Record<string, SQLiteColumn>,
  preserve: readonly SQLiteColumn[] = []
): Record<string, SQL> {
  const kept = new Set(preserve.map((column) => column.name));
  return Object.fromEntries(
    Object.entries(columns)
      .filter(([, column]) => !kept.has(column.name))
      .map(([field, column]) => [field, excluded(column)])
  );
}

export class RecordFault extends Error {
  override readonly name = "RecordFault";
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string) {
    super(`${path || "(record)"}: ${reason}`);
    this.path = path;
    this.reason = reason;
  }
}

export function below(at: string, path: string): string {
  if (path === "") {
    return at;
  }
  return path.startsWith("[") ? `${at}${path}` : `${at}.${path}`;
}
