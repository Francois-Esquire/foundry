import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

/**
 * `column IN values`, the list bound as one JSON parameter and read back
 * with `json_each`: one statement binds only so many values (32,766), and
 * a list whose length a caller decides (a commit's deletes, a workspace's
 * parked Runs, an observer's types) must not fail past them.
 */
export function inList(column: SQLiteColumn, values: readonly string[]): SQL {
  return sql`${column} in (select value from json_each(${JSON.stringify(values)}))`;
}
