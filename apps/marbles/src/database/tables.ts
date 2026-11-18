import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const marblesWorkspaces = sqliteTable("marbles_workspaces", {
  config: text(),
  cwd: text(),
  firstSeen: text("first_seen").notNull(),
  hosted: integer({ mode: "boolean" }).notNull().default(false),
  id: text().primaryKey(),
  lastSeen: text("last_seen").notNull(),
  root: text().notNull(),
});

export const marblesChanges = sqliteTable(
  "marbles_changes",
  {
    id: text().notNull(),
    payload: text({ mode: "json" }).$type<unknown>().notNull(),
    position: integer().notNull(),
    recordedAt: integer("recorded_at").notNull(),
    runId: text("run_id"),
    scope: text().notNull(),
    source: text().notNull(),
    type: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.position] }),
    index("marbles_changes_scope_source_position").on(
      table.scope,
      table.source,
      table.position
    ),
  ]
);

export const marblesChangeLogs = sqliteTable("marbles_change_logs", {
  compacted: integer().notNull().default(0),
  position: integer().notNull().default(0),
  scope: text().primaryKey(),
});

export const marblesObservers = sqliteTable(
  "marbles_observers",
  {
    failures: integer().notNull().default(0),
    lastError: text("last_error"),
    missedFrom: integer("missed_from"),
    missedThrough: integer("missed_through"),
    name: text().notNull(),
    position: integer().notNull(),
    retryAt: integer("retry_at"),
    scope: text().notNull(),
    seenAt: integer("seen_at").notNull(),
    source: text().notNull(),
    stuckSince: integer("stuck_since"),
  },
  (table) => [primaryKey({ columns: [table.scope, table.source, table.name] })]
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

export const marblesWorkflowRuns = sqliteTable(
  "marbles_workflow_runs",
  {
    ledger: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    literals: text({ mode: "json" })
      .$type<Record<string, Record<string, unknown>>>()
      .notNull(),
    ownerId: text("owner_id"),
    ownerPid: integer("owner_pid"),
    ownerStarted: text("owner_started"),
    runId: text("run_id").notNull(),
    scope: text().notNull(),
    sessionId: text("session_id"),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.runId] }),
    index("marbles_workflow_runs_scope_owner").on(table.scope, table.ownerId),
  ]
);

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
    ownerStarted: text("owner_started"),
    scope: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.key] })]
);

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

export const marblesAutomations = sqliteTable(
  "marbles_automations",
  {
    agentId: text("agent_id").notNull(),
    at: text({ mode: "json" }).$type<unknown>().notNull(),
    createdAt: text("created_at").notNull(),
    enabled: integer({ mode: "boolean" }).notNull(),
    id: text().notNull(),
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
    ownerStarted: text("owner_started"),
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

export const marblesProviderConfigurations = sqliteTable(
  "marbles_provider_configurations",
  {
    configuration: text().notNull(),
    revision: integer().notNull(),
    scope: text().primaryKey(),
  },
  (table) => [
    index("marbles_provider_configurations_revision").on(table.revision),
  ]
);

export const marblesIdentityKeys = sqliteTable("marbles_identity_keys", {
  id: integer().primaryKey(),
  key: text().notNull(),
});

export const marblesAgentGrants = sqliteTable("marbles_agent_grants", {
  grants: text().notNull(),
  scope: text().primaryKey(),
});

export const marblesDeferredApprovals = sqliteTable(
  "marbles_deferred_approvals",
  {
    approvals: text({ mode: "json" }).$type<unknown>().notNull(),
    scope: text().primaryKey(),
  }
);

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

export const marblesDeliveryClaims = sqliteTable("marbles_delivery_claims", {
  ownerId: text("owner_id"),
  ownerPid: integer("owner_pid"),
  ownerStarted: text("owner_started"),
  scope: text().primaryKey(),
});

export const marblesRecoveries = sqliteTable("marbles_recoveries", {
  at: text().notNull(),
  scope: text().primaryKey(),
  steps: text({ mode: "json" }).$type<unknown>().notNull(),
});

export const marblesGenerations = sqliteTable(
  "marbles_generations",
  {
    createdAt: text("created_at").notNull(),
    error: text(),
    fingerprint: text().notNull(),
    number: integer().primaryKey({ autoIncrement: true }),
    pid: integer().notNull(),
    started: text(),
    state: text({
      enum: ["loading", "current", "retiring", "failed", "exited"],
    }).notNull(),
    updatedAt: text("updated_at").notNull(),
    workspaces: text({ mode: "json" })
      .$type<readonly string[]>()
      .notNull()
      .default([]),
  },
  (table) => [index("marbles_generations_state_idx").on(table.state)]
);
