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

/**
 * Each schedule's and monitor's tick, by the trigger's key, as a newer
 * engine declaring the same trigger finds it: how its last tick went (all
 * null until the first one has run), and the engine whose tick is under
 * way (`owner_id`, unique per engine, and its process, `owner_pid`), null
 * between ticks. Written by `database/triggers.ts`, a claim and a finished
 * tick each in a transaction of its own.
 */
export const marblesScheduleTicks = sqliteTable(
  "marbles_schedule_ticks",
  {
    key: text().notNull(),
    kind: text({ enum: ["schedule", "monitor"] }),
    label: text(),
    lastFinish: text("last_finish"),
    lastStart: text("last_start"),
    lastStatus: text("last_status", { enum: ["complete", "failed"] }),
    nextDue: text("next_due"),
    ownerId: text("owner_id"),
    ownerPid: integer("owner_pid"),
    scope: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.key] })]
);

/**
 * What each monitor keeps, by its key: what it last saw of its source,
 * and the launch it handed out that no tick has started yet, if any.
 */
export const marblesMonitorStates = sqliteTable(
  "marbles_monitor_states",
  {
    key: text().notNull(),
    observed: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    pending: text({ mode: "json" }).$type<{
      readonly input: unknown;
      readonly workflow: string;
    }>(),
    scope: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.key] })]
);

/**
 * Every usage fact of a workspace, one per turn (`turn_id`), filed under
 * the run it ran in (`run_id`), or none for a direct session's, as the
 * ledger read it when it saved it. `fact` is the record whole, read back
 * through `usageFactSchema`; `lost` repeats its marker reason, so a saved
 * fact is told from a marker without reading it. `revision` grows with
 * every fact kept in the scope, so a reader can tell nothing changed
 * without reading the facts. Written by `database/usage.ts`; nothing
 * removes a row.
 */
export const marblesUsageFacts = sqliteTable(
  "marbles_usage_facts",
  {
    fact: text({ mode: "json" }).$type<unknown>().notNull(),
    lost: text(),
    revision: integer().notNull(),
    runId: text("run_id"),
    scope: text().notNull(),
    turnId: text("turn_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.turnId] }),
    index("marbles_usage_facts_scope_revision").on(table.scope, table.revision),
  ]
);

/**
 * The automations agents created in a workspace, one per id: what each
 * targets and when (`workflow`, `at`, `input`, and `source` for a
 * monitor), whether it is on, and the agent session that owns it, which
 * alone may change it. `at`, `input` and `source` are the spec's own
 * shapes, read back through the record's schema. Written by
 * `database/automations.ts`, an edit that reads first in a transaction.
 */
export const marblesAutomations = sqliteTable(
  "marbles_automations",
  {
    agentId: text("agent_id").notNull(),
    at: text({ mode: "json" }).$type<unknown>().notNull(),
    createdAt: text("created_at").notNull(),
    enabled: integer({ mode: "boolean" }).notNull(),
    id: text().notNull(),
    /** The launch input as JSON text, `null` included; SQL NULL when the spec has none. */
    input: text(),
    key: text().notNull(),
    ownerDefinition: text("owner_definition").notNull(),
    ownerPath: text("owner_path", { mode: "json" })
      .$type<readonly string[]>()
      .notNull(),
    ownerRunId: text("owner_run_id").notNull(),
    scope: text().notNull(),
    sessionId: text("session_id").notNull(),
    source: text({ mode: "json" }).$type<unknown>(),
    version: integer().notNull(),
    workflow: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.id] })]
);
