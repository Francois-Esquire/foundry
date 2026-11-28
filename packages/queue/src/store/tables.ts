import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type {
  Job,
  JobId,
  JobState,
  Run,
  RunId,
  RunState,
  Suspension,
  SuspensionId,
  SuspensionState,
} from "../domain";

export const queueJobs = sqliteTable(
  "queue_jobs",
  {
    body: text("body", { mode: "json" }).$type<Job>().notNull(),
    id: text("id").$type<JobId>().notNull(),
    idempotencyKey: text("idempotency_key"),
    scope: text("scope").notNull(),
    state: text("state").$type<JobState["kind"]>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("queue_jobs_scope_state").on(table.scope, table.state),
    uniqueIndex("queue_jobs_scope_idempotency_key").on(
      table.scope,
      table.idempotencyKey
    ),
  ]
);

export const queueRuns = sqliteTable(
  "queue_runs",
  {
    availableAt: integer("available_at"),
    body: text("body", { mode: "json" }).$type<Run>().notNull(),
    id: text("id").$type<RunId>().notNull(),
    jobId: text("job_id").$type<JobId>().notNull(),
    pool: text("pool"),
    scope: text("scope").notNull(),
    state: text("state").$type<RunState["kind"]>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("queue_runs_scope_state").on(table.scope, table.state),
    index("queue_runs_scope_job").on(table.scope, table.jobId),
    index("queue_runs_scope_state_available").on(
      table.scope,
      table.state,
      table.availableAt
    ),
    index("queue_runs_scope_pool_state").on(
      table.scope,
      table.pool,
      table.state
    ),
  ]
);

export const queueSuspensions = sqliteTable(
  "queue_suspensions",
  {
    body: text("body", { mode: "json" }).$type<Suspension>().notNull(),
    id: text("id").$type<SuspensionId>().notNull(),
    runId: text("run_id").$type<RunId>().notNull(),
    scope: text("scope").notNull(),
    state: text("state").$type<SuspensionState["kind"]>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("queue_suspensions_scope_run").on(table.scope, table.runId),
  ]
);

export const queuePools = sqliteTable(
  "queue_pools",
  {
    limit: integer("limit"),
    name: text("name").notNull(),
    scope: text("scope").notNull(),
    state: text("state").$type<"active" | "paused">().notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.name] })]
);

export const queueWatermarks = sqliteTable(
  "queue_watermarks",
  {
    scope: text("scope").notNull(),
    value: integer("value").notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope] })]
);

export const queueTables = [
  queueJobs,
  queueRuns,
  queueSuspensions,
  queuePools,
  queueWatermarks,
];
