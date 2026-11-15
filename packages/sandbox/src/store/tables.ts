import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import { CONTAINER_ROW_STATUSES } from "../container/constants";

/**
 * The table the SQLite container store reads and writes, for a host to
 * compose into its own schema and migrations. It holds `ContainerRow` from
 * `@foundry/sandbox/schema` field for field, as the row holds it, plus two
 * columns the row has not:
 *
 * - `scope`, an opaque partition key the host chooses, first in every key.
 * - `position`, the order a row was first put in its scope. `list` returns
 *   rows by it, as the memory store lists its rows, and a row put again
 *   keeps its position.
 *
 * `native_id` is NULL for a row whose `nativeId` is `undefined`; the row has
 * no `null` to confuse it with.
 */

/** One row per container. */
export const sandboxContainers = sqliteTable(
  "sandbox_containers",
  {
    /** Epoch milliseconds; see the SQLite store for the numbers it refuses. */
    createdAt: integer("created_at").notNull(),
    id: text("id").notNull(),
    nativeId: text("native_id"),
    position: integer("position").notNull(),
    scope: text("scope").notNull(),
    spec: text("spec").notNull(),
    status: text("status", { enum: CONTAINER_ROW_STATUSES }).notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("sandbox_containers_scope_position").on(table.scope, table.position),
  ]
);
