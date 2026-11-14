import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type { JsonObject, TaskId } from "../schema";
import { TASK_STATUSES } from "../schema";

/**
 * The tables `SqliteTaskStore` reads and writes, for a host to compose into
 * its own schema and migrations. Each holds the matching record from
 * `@foundry/tasks/schema` field for field, as the record holds it, plus
 * two columns the record has not:
 *
 * - `scope`, an opaque partition key the host chooses, first in every key.
 * - `position`, the order a row was first put in its scope. Reads list rows
 *   by it, as the memory store lists its records, and a row put again keeps
 *   its position.
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

/** One row per `TaskDependency`: `taskId` waits on `dependsOnId`. */
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
