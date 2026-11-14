import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { JsonObject, TaskId } from "../schema";
import { TASK_STATUSES } from "../schema";

/**
 * The tables `SqliteTaskStore` reads and writes, for a host to compose into
 * its own schema and migrations. Each holds the matching record from
 * `@foundry/tasks/schema` field for field, as the record holds it, plus
 * `scope`: an opaque partition key the host chooses, first in every key.
 */

/** One row per `Task`. */
export const tasks = sqliteTable(
  "tasks",
  {
    createdAt: text("created_at").notNull(),
    description: text("description"),
    id: text("id").$type<TaskId>().notNull(),
    metadata: text("metadata", { mode: "json" }).$type<JsonObject>().notNull(),
    parentId: text("parent_id").$type<TaskId>(),
    scope: text("scope").notNull(),
    settledAt: text("settled_at"),
    status: text("status", { enum: TASK_STATUSES }).notNull(),
    tags: text("tags", { mode: "json" }).$type<readonly string[]>().notNull(),
    title: text("title").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.id] })]
);

/** One row per `TaskDependency`: `taskId` waits on `dependsOnId`. */
export const taskDependencies = sqliteTable(
  "task_dependencies",
  {
    dependsOnId: text("depends_on_id").$type<TaskId>().notNull(),
    scope: text("scope").notNull(),
    taskId: text("task_id").$type<TaskId>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.taskId, table.dependsOnId] }),
  ]
);
