import type { ExtractTablesWithRelations, SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type {
  BaseSQLiteDatabase,
  SQLiteColumn,
  SQLiteTransaction,
} from "drizzle-orm/sqlite-core";
import { customType } from "drizzle-orm/sqlite-core";

export type SqliteDatabase = BaseSQLiteDatabase<
  "async",
  unknown,
  Record<string, unknown>
>;

export type SqliteTransaction = SQLiteTransaction<
  "async",
  unknown,
  Record<string, unknown>,
  ExtractTablesWithRelations<Record<string, unknown>>
>;

export type SqliteSyncDatabase = BaseSQLiteDatabase<
  "sync",
  unknown,
  Record<string, unknown>
>;

export type SqliteSyncTransaction = SQLiteTransaction<
  "sync",
  unknown,
  Record<string, unknown>,
  ExtractTablesWithRelations<Record<string, unknown>>
>;

export const SQLITE_MAX_PARAMETERS = 32_766;
export const SQLITE_D1_MAX_PARAMETERS = 100;

export type SqliteBytesDriverData = ArrayBuffer | ArrayBufferView | Uint8Array;

function toPlainUint8Array(value: SqliteBytesDriverData): Uint8Array {
  if (value instanceof Uint8Array) {
    return value.constructor === Uint8Array
      ? value
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value);
}

/**
 * Web-standard SQLite BLOB column mapped to `Uint8Array` without touching Node
 * `Buffer` (safe in browsers, Cloudflare Workers/D1/DO, and Node/Bun).
 */
export const sqliteBytes = customType<{
  data: Uint8Array;
  driverData: SqliteBytesDriverData;
}>({
  dataType() {
    return "blob";
  },
  fromDriver(value) {
    return toPlainUint8Array(value);
  },
  toDriver(value) {
    return value;
  },
});

export const UNSTORABLE_TEXT =
  "text holding U+0000 or a lone surrogate (not well-formed UTF-16) does not read back intact from SQLite";

const UNSTORABLE_TIME =
  "a time that is not a valid Date has no epoch milliseconds to store";

const UNSTORABLE_INTEGER =
  "SQLite keeps an integer column as a safe integer, and reads -0 back as 0";

export function storableText(text: unknown): text is string {
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
      return typeof value === "string" && !storableText(value)
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
  if (scope.length === 0 || !storableText(scope)) {
    throw new RangeError(
      "scope must be a nonempty string with no U+0000 and no lone surrogate"
    );
  }
}

export function resolveMaxParameters(
  maxParameters = SQLITE_MAX_PARAMETERS
): number {
  if (!Number.isSafeInteger(maxParameters) || maxParameters <= 0) {
    throw new RangeError("maxParameters must be a positive safe integer");
  }
  return maxParameters;
}

export function maxBatchRows(
  columnCount: number,
  maxParameters = SQLITE_MAX_PARAMETERS,
  reservedParameters = 0
): number {
  if (!Number.isSafeInteger(columnCount) || columnCount <= 0) {
    throw new RangeError("columnCount must be a positive safe integer");
  }
  if (!Number.isSafeInteger(reservedParameters) || reservedParameters < 0) {
    throw new RangeError(
      "reservedParameters must be a non-negative safe integer"
    );
  }
  const limit = resolveMaxParameters(maxParameters);
  if (columnCount + reservedParameters > limit) {
    throw new RangeError(
      `a single row (${String(columnCount)} columns + ${String(reservedParameters)} reserved parameters) exceeds maxParameters (${String(limit)})`
    );
  }
  return Math.floor((limit - reservedParameters) / columnCount);
}

export function rowBatches<T>(
  items: readonly T[],
  columnCount: number,
  maxParameters = SQLITE_MAX_PARAMETERS,
  reservedParameters = 0
): T[][] {
  return batches(
    items,
    maxBatchRows(columnCount, maxParameters, reservedParameters)
  );
}

export function batches<T>(
  items: readonly T[],
  size = SQLITE_MAX_PARAMETERS
): T[][] {
  if (Number.isNaN(size)) {
    throw new RangeError("batch size must not be NaN");
  }
  const length = Math.max(1, Math.floor(size));
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += length) {
    result.push(items.slice(start, start + length));
  }
  return result;
}

export function excluded(column: SQLiteColumn): SQL {
  return sql.raw(`excluded."${column.name.replaceAll('"', '""')}"`);
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

export function joinFieldPath(at: string, path: string): string {
  if (path === "") {
    return at;
  }
  return path.startsWith("[") ? `${at}${path}` : `${at}.${path}`;
}
