import type { TaskEvent } from "@foundry/tasks";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * Marbles' own tables. A workspace's id is the scope every package's rows
 * are partitioned by, so this table, the registry of those ids, has none.
 */

/**
 * Every workspace this machine has run, and whether the Marbles process
 * hosts it. One row per id; `first_seen` is set once, `last_seen` on every
 * sight. Times are ISO strings, as the record holds them.
 */
export const marblesWorkspaces = sqliteTable("marbles_workspaces", {
  config: text(),
  firstSeen: text("first_seen").notNull(),
  hosted: integer({ mode: "boolean" }).notNull().default(false),
  id: text().primaryKey(),
  lastSeen: text("last_seen").notNull(),
  root: text().notNull(),
});

/**
 * Every change a workspace's tasks committed, as the `TaskEvent` the write
 * carried, for the workspace's observers: written by the task store's
 * `onCommit` hook in the commit's own transaction, so a change and its row
 * land together or not at all. `scope` is the workspace id, as on the
 * tasks' own rows; `position` is the order the changes were committed in.
 * Nothing removes a row.
 */
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

/**
 * Which observers completed which change: one row per change and the hash
 * of the handler that completed it (see `lib/events/delivery.ts`). Nothing
 * removes a row.
 */
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

/**
 * A workspace's sessions, each with a revision that grows with every
 * commit that puts the session or a message in it: written by the session
 * store's `onCommit` hook in the commit's own transaction
 * (`database/sessions.ts`), so it lists exactly the sessions the
 * `@foundry/agents` tables hold, and a reader can tell which of them
 * changed since it last read them without reading their messages.
 */
export const marblesSessionRevisions = sqliteTable(
  "marbles_session_revisions",
  {
    revision: integer().notNull(),
    scope: text().notNull(),
    sessionId: text("session_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.sessionId] })]
);

/**
 * What Marbles keeps beside each workflow Run of a workspace, the
 * `@foundry/workflows` rows of the same scope and id: what the run's scope
 * recorded (its ledger, each node's literal input, the run's session), so
 * a parked run rebuilt in a later process finds the same sessions and
 * artifacts, and the engine that owns the Run (`owner_id`, unique per
 * engine, and its process, `owner_pid`), null once no engine does. Written
 * by the workflow store's `onCommit` hook in the commit's own transaction
 * (`database/runs.ts`), and by a claim in a transaction of its own. A row
 * goes with its Run.
 */
export const marblesWorkflowRuns = sqliteTable(
  "marbles_workflow_runs",
  {
    ledger: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    literals: text({ mode: "json" })
      .$type<Record<string, Record<string, unknown>>>()
      .notNull(),
    ownerId: text("owner_id"),
    ownerPid: integer("owner_pid"),
    runId: text("run_id").notNull(),
    scope: text().notNull(),
    sessionId: text("session_id"),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.runId] }),
    index("marbles_workflow_runs_scope_owner").on(table.scope, table.ownerId),
  ]
);
