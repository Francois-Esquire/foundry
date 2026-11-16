import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

const ROWS_PER_STATEMENT = 500;

export function batches<T>(items: readonly T[]): T[][] {
  const runs: T[][] = [];
  for (let start = 0; start < items.length; start += ROWS_PER_STATEMENT) {
    runs.push(items.slice(start, start + ROWS_PER_STATEMENT));
  }
  return runs;
}

export function inList(column: SQLiteColumn, values: readonly string[]): SQL {
  return sql`${column} in (select value from json_each(${JSON.stringify(values)}))`;
}
