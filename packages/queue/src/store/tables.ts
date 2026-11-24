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
  Wait,
  WaitId,
  WaitState,
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
    body: text("body", { mode: "json" }).$type<Run>().notNull(),
    id: text("id").$type<RunId>().notNull(),
    jobId: text("job_id").$type<JobId>().notNull(),
    scope: text("scope").notNull(),
    state: text("state").$type<RunState["kind"]>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("queue_runs_scope_state").on(table.scope, table.state),
    index("queue_runs_scope_job").on(table.scope, table.jobId),
  ]
);

export const queueWaits = sqliteTable(
  "queue_waits",
  {
    body: text("body", { mode: "json" }).$type<Wait>().notNull(),
    id: text("id").$type<WaitId>().notNull(),
    runId: text("run_id").$type<RunId>().notNull(),
    scope: text("scope").notNull(),
    state: text("state").$type<WaitState["kind"]>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("queue_waits_scope_run").on(table.scope, table.runId),
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

export const queueTables = [queueJobs, queueRuns, queueWaits, queuePools];
