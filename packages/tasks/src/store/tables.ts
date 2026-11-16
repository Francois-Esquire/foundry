import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type { JsonObject, TaskId } from "../schema";
import { TASK_STATUSES } from "../schema";

export const tasks = sqliteTable(
  "tasks",
  {
    createdAt: text("created_at").notNull(),
    description: text("description"),
    id: text("id").$type<TaskId>().notNull(),
    metadata: text("metadata", { mode: "json" }).$type<JsonObject>().notNull(),
    parentId: text("parent_id").$type<TaskId>(),
    position: integer("position").notNull(),
    scope: text("scope").notNull(),
    settledAt: text("settled_at"),
    status: text("status", { enum: TASK_STATUSES }).notNull(),
    tags: text("tags", { mode: "json" }).$type<readonly string[]>().notNull(),
    title: text("title").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("tasks_scope_position").on(table.scope, table.position),
  ]
);

export const taskDependencies = sqliteTable(
  "task_dependencies",
  {
    dependsOnId: text("depends_on_id").$type<TaskId>().notNull(),
    position: integer("position").notNull(),
    scope: text("scope").notNull(),
    taskId: text("task_id").$type<TaskId>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.taskId, table.dependsOnId] }),
    index("task_dependencies_scope_position").on(table.scope, table.position),
  ]
);
