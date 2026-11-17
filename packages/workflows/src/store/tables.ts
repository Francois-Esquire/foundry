import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import type { JsonValue } from "../json-value";
import type {
  DefinitionReference,
  ErrorShape,
  JobLinks,
  JobRecord,
  RunFramePayload,
  RunLinks,
  RunRecord,
  SuspensionRecord,
} from "../schema";
import {
  JOB_STATUSES,
  QUEUE_STATUSES,
  RUN_STATUSES,
  SUSPENSION_STATUSES,
} from "../schema";

export const workflowPositions = sqliteTable(
  "workflow_positions",
  {
    next: integer("next").notNull(),
    scope: text("scope").notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope] })]
);

export const workflowQueues = sqliteTable(
  "workflow_queues",
  {
    createdAt: integer("created_at").notNull(),
    extensions: text("extensions", { mode: "json" })
      .$type<Readonly<Record<string, JsonValue>>>()
      .notNull(),
    id: text("id").notNull(),
    lastError: text("last_error", { mode: "json" }).$type<ErrorShape>(),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    scope: text("scope").notNull(),
    status: text("status", { enum: QUEUE_STATUSES }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("workflow_queues_scope_position").on(table.scope, table.position),
  ]
);

export const workflowJobs = sqliteTable(
  "workflow_jobs",
  {
    definition: text("definition", { mode: "json" })
      .$type<DefinitionReference>()
      .notNull(),
    id: text("id").notNull(),
    input: text("input", { mode: "json" }).$type<JsonValue>(),
    links: text("links", { mode: "json" }).$type<JobLinks>().notNull(),
    position: integer("position").notNull(),
    scope: text("scope").notNull(),
    status: text("status", { enum: JOB_STATUSES }).notNull(),
    timestamps: text("timestamps", { mode: "json" })
      .$type<JobRecord["timestamps"]>()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("workflow_jobs_scope_position").on(table.scope, table.position),
  ]
);

export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    definition: text("definition", {
      mode: "json",
    }).$type<DefinitionReference>(),
    error: text("error", { mode: "json" }).$type<ErrorShape>(),
    extensions: text("extensions", { mode: "json" })
      .$type<Readonly<Record<string, JsonValue>>>()
      .notNull(),
    id: text("id").notNull(),
    input: text("input", { mode: "json" }).$type<JsonValue>(),
    links: text("links", { mode: "json" }).$type<RunLinks>(),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    output: text("output", { mode: "json" }).$type<JsonValue>(),
    position: integer("position").notNull(),
    queueId: text("queue_id").notNull(),
    scope: text("scope").notNull(),
    snapshot: text("snapshot", { mode: "json" })
      .$type<RunRecord["snapshot"]>()
      .notNull(),
    status: text("status", { enum: RUN_STATUSES }).notNull(),
    step: text("step").notNull(),
    tags: text("tags", { mode: "json" })
      .$type<Record<string, string>>()
      .notNull(),
    timestamps: text("timestamps", { mode: "json" })
      .$type<RunRecord["timestamps"]>()
      .notNull(),
    undeclared: text("undeclared", { mode: "json" }).$type<
      Record<string, JsonValue>
    >(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("workflow_runs_scope_position").on(table.scope, table.position),
  ]
);

export const workflowSuspensions = sqliteTable(
  "workflow_suspensions",
  {
    id: text("id").notNull(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    occurrence: integer("occurrence").notNull(),
    position: integer("position").notNull(),
    reason: text("reason").notNull(),
    request: text("request", { mode: "json" }).$type<JsonValue>(),
    resolution: text("resolution", { mode: "json" }).$type<JsonValue>(),
    revision: integer("revision").notNull(),
    runId: text("run_id").notNull(),
    scope: text("scope").notNull(),
    status: text("status", { enum: SUSPENSION_STATUSES }).notNull(),
    stepPath: text("step_path", { mode: "json" })
      .$type<readonly string[]>()
      .notNull(),
    timestamps: text("timestamps", { mode: "json" })
      .$type<SuspensionRecord["timestamps"]>()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("workflow_suspensions_scope_position").on(
      table.scope,
      table.position
    ),
    index("workflow_suspensions_scope_run_position").on(
      table.scope,
      table.runId,
      table.position
    ),
  ]
);

export const workflowRunFrames = sqliteTable(
  "workflow_run_frames",
  {
    at: integer("at").notNull(),
    cursor: integer("cursor").notNull(),
    payload: text("payload", { mode: "json" })
      .$type<RunFramePayload>()
      .notNull(),
    position: integer("position").notNull(),
    runId: text("run_id").notNull(),
    scope: text("scope").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.runId, table.cursor] }),
    index("workflow_run_frames_scope_position").on(table.scope, table.position),
    index("workflow_run_frames_scope_run_position").on(
      table.scope,
      table.runId,
      table.position
    ),
  ]
);
