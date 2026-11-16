import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import { CONTAINER_ROW_STATUSES } from "../container/constants";

export const sandboxContainers = sqliteTable(
  "sandbox_containers",
  {
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
