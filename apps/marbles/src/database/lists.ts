import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

/**
 * Rows per statement when one write puts more rows than one statement may
 * carry: Marbles' widest row binds eight values, so a batch binds a few
 * thousand, far under SQLite's 32,766.
 */
const ROWS_PER_STATEMENT = 500;

/** `items` in runs of at most `ROWS_PER_STATEMENT`, each for one statement. */
export function batches<T>(items: readonly T[]): T[][] {
  const runs: T[][] = [];
  for (let start = 0; start < items.length; start += ROWS_PER_STATEMENT) {
    runs.push(items.slice(start, start + ROWS_PER_STATEMENT));
  }
  return runs;
}

/**
 * `column IN values`, the list bound as one JSON parameter and read back
 * with `json_each`: one statement binds only so many values (32,766), and
 * a list whose length a caller decides (a commit's deletes, a workspace's
 * parked Runs, an observer's types) must not fail past them.
 */
export function inList(column: SQLiteColumn, values: readonly string[]): SQL {
  return sql`${column} in (select value from json_each(${JSON.stringify(values)}))`;
}
