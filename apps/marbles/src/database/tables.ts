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
 * Every workspace this machine has run, with enough to load it again from
 * the row alone (its root, its source, and where its work starts). One row
 * per id; `first_seen` is set once, `last_seen` on every sight. Times are
 * ISO strings, as the record holds them.
 *
 * `hosted` says the workspace is registered with the Marbles process:
 * attached (`marbles attach`, a CLI run the process hosts) or registered
 * through `HostedWorkspaces.register`, and not detached since. The Marbles
 * process loads every hosted workspace again when it starts
 * (`HostedWorkspaces.loadRegistered`), and reports each one that fails. A
 * row a command only read or ran, with no Marbles process hosting it,
 * stays unhosted.
 */
export const marblesWorkspaces = sqliteTable("marbles_workspaces", {
  config: text(),
  /** Where the workspace's work starts; its root when null. */
  cwd: text(),
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
 * through `usageFactSchema`, a `lost` marker's reason with it. `revision` grows with
 * every fact kept in the scope, so a reader can tell nothing changed
 * without reading the facts. Written by `database/usage.ts`; nothing
 * removes a row.
 */
export const marblesUsageFacts = sqliteTable(
  "marbles_usage_facts",
  {
    fact: text({ mode: "json" }).$type<unknown>().notNull(),
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

/**
 * Every Execution Run a workspace retains, one per id: what launched it
 * (`kind`, `name`, `queue`, the caller's `source` and `correlation`), where
 * it is (`status`, `progress`, `error_*`, the times), the process that owns
 * it while it is unsettled (`owner_pid`), its admission order
 * (`sequence`), and the `revision` every change raises. `input` and
 * `progress` are JSON text, `null` included; SQL NULL when the run has
 * none. Its observations are rows of their own
 * (`marbles_execution_observations`). Written by
 * `database/executions.ts`, under the rules `ExecutionStore` states: a
 * lifecycle change only from a status it allows and by the owner it
 * names, an advisory one only while the run is unsettled.
 */
export const marblesExecutions = sqliteTable(
  "marbles_executions",
  {
    correlation: text({ mode: "json" })
      .$type<Record<string, string>>()
      .notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    id: text().notNull(),
    input: text(),
    kind: text({ enum: ["workflow", "task"] }).notNull(),
    name: text().notNull(),
    ownerPid: integer("owner_pid").notNull(),
    progress: text(),
    queue: text().notNull(),
    queuedAt: text("queued_at").notNull(),
    revision: integer().notNull(),
    scope: text().notNull(),
    sequence: integer().notNull(),
    settledAt: text("settled_at"),
    source: text(),
    startedAt: text("started_at"),
    status: text().notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("marbles_executions_scope_source").on(
      table.scope,
      table.name,
      table.source
    ),
  ]
);

/**
 * Each Execution Run's observations, one row per observation id, in the
 * order they were last recorded (`position`, after every other the run
 * has): recording one again replaces its row and moves it last, so a
 * record costs the same however many its run has. Goes with its run.
 */
export const marblesExecutionObservations = sqliteTable(
  "marbles_execution_observations",
  {
    observation: text({ mode: "json" }).$type<unknown>().notNull(),
    observationId: text("observation_id").notNull(),
    position: integer().notNull(),
    runId: text("run_id").notNull(),
    scope: text().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.scope, table.runId, table.observationId],
    }),
    index("marbles_execution_observations_scope_run_position").on(
      table.scope,
      table.runId,
      table.position
    ),
  ]
);

/**
 * What pruning removed from a workspace's Execution Runs, by host scope
 * (`gap_scope`, such as a Module): how many, the latest settlement among
 * them (`through`), and when one was last removed. Written in the same
 * transaction as the removals it counts.
 */
export const marblesExecutionGaps = sqliteTable(
  "marbles_execution_gaps",
  {
    gapScope: text("gap_scope").notNull(),
    removed: integer().notNull(),
    scope: text().notNull(),
    through: text().notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.gapScope] })]
);

/**
 * Provider configuration, one row per scope it is kept for: the machine's,
 * whose `scope` is the empty string, and each workspace's own, by the
 * workspace id. `configuration` is the scope's entries (and, for a
 * workspace, its `order`), read back through the configuration's schema;
 * its settings may hold secrets, which is one reason the database file is
 * its owner's only. `revision` is one more than the highest in the table
 * at every write, so a reader notices a change anywhere without reading
 * the entries. Written by `database/providers.ts`, an edit that reads
 * first in a transaction.
 */
export const marblesProviderConfigurations = sqliteTable(
  "marbles_provider_configurations",
  {
    /** JSON text, parsed by the store itself, so no parser message can quote a secret. */
    configuration: text().notNull(),
    revision: integer().notNull(),
    scope: text().primaryKey(),
  },
  (table) => [
    index("marbles_provider_configurations_revision").on(table.revision),
  ]
);

/**
 * The machine's key for provider instance identities: one row, `id` 1,
 * the key as hex. Made once by the first writer that needs it and never
 * rewritten; a new key matches no pinned session.
 */
export const marblesIdentityKeys = sqliteTable("marbles_identity_keys", {
  id: integer().primaryKey(),
  key: text().notNull(),
});

/**
 * A workspace's agent grants, as one document: every grant it was issued,
 * revoked and claimed ones too, and the sequence their ids are drawn from,
 * in the form `@foundry/lib`'s grant repository validates before it trusts
 * any of it. Written by `database/grants.ts`, each operation a
 * transaction that reads the document, applies one transition, and
 * writes it.
 */
export const marblesAgentGrants = sqliteTable("marbles_agent_grants", {
  /** JSON text, which the repository parses itself, so no parser message can quote it. */
  grants: text().notNull(),
  scope: text().primaryKey(),
});

/**
 * The approvals a workspace's agents left waiting for a person, and the
 * sessions they belong to, as one document: references to each session's
 * own requests, never tool inputs. Written by `database/approvals.ts`, an
 * edit that reads first in a transaction.
 */
export const marblesDeferredApprovals = sqliteTable(
  "marbles_deferred_approvals",
  {
    approvals: text({ mode: "json" }).$type<unknown>().notNull(),
    scope: text().primaryKey(),
  }
);

/**
 * The latest of each harness activity a workspace's agents reported, by
 * its key (the session and the activity), for the dashboard: the event
 * and the step it came from, read back through the activity schema. A
 * row is only ever replaced by a higher `revision` of the same activity.
 */
export const marblesHarnessActivities = sqliteTable(
  "marbles_harness_activities",
  {
    key: text().notNull(),
    record: text({ mode: "json" }).$type<unknown>().notNull(),
    revision: integer().notNull(),
    scope: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.key] })]
);

/**
 * Which engine delivers a workspace's task changes to its observers: the
 * engine (`owner_id`, unique per engine) and its process (`owner_pid`),
 * null once it let go. A claim is a transaction that reads the row and
 * takes it; an owner whose process has exited holds nothing.
 */
export const marblesDeliveryClaims = sqliteTable("marbles_delivery_claims", {
  ownerId: text("owner_id"),
  ownerPid: integer("owner_pid"),
  scope: text().primaryKey(),
});
