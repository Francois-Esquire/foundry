import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import { CONTAINER_ROW_STATUSES } from "./schema";

export const sandboxContainers = sqliteTable(
  "sandbox_containers",
  // biome-ignore assist/source/useSortedKeys: columns in the order a table gets them, `holder` added last to one that existed before it.
  {
    createdAt: integer("created_at").notNull(),
    id: text("id").notNull(),
    nativeId: text("native_id"),
    position: integer("position").notNull(),
    scope: text("scope").notNull(),
    spec: text("spec").notNull(),
    status: text("status", { enum: CONTAINER_ROW_STATUSES }).notNull(),
    updatedAt: integer("updated_at").notNull(),
    holder: text("holder"),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("sandbox_containers_scope_position").on(table.scope, table.position),
  ]
);
