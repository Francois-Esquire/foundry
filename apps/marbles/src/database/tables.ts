import type { TaskEvent } from "@foundry/tasks";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const marblesWorkspaces = sqliteTable("marbles_workspaces", {
  config: text(),
  firstSeen: text("first_seen").notNull(),
  hosted: integer({ mode: "boolean" }).notNull().default(false),
  id: text().primaryKey(),
  lastSeen: text("last_seen").notNull(),
  root: text().notNull(),
});

export const marblesTaskChanges = sqliteTable(
  "marbles_task_changes",
  {
    id: text().notNull(),
    payload: text({ mode: "json" }).$type<TaskEvent>().notNull(),
    position: integer().notNull(),
    scope: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("marbles_task_changes_scope_position").on(
      table.scope,
      table.position
    ),
  ]
);

export const marblesTaskChangeDeliveries = sqliteTable(
  "marbles_task_change_deliveries",
  {
    changeId: text("change_id").notNull(),
    handler: text().notNull(),
    scope: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.changeId, table.handler] }),
  ]
);

export const marblesSessionRevisions = sqliteTable(
  "marbles_session_revisions",
  {
    revision: integer().notNull(),
    scope: text().notNull(),
    sessionId: text("session_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.sessionId] })]
);
