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

/**
 * The tables `SqliteWorkflowStore` reads and writes, for a host to compose
 * into its own schema and migrations. Each holds the matching record from
 * `@foundry/workflows/schema` with one column per top-level field, as the
 * record holds it: text stays text, epoch milliseconds and counters are
 * integers, and a field holding an object, an array or any JSON value is
 * JSON text, read back whole. No read filters or orders on anything inside
 * a JSON column. Every table also has two columns its record has not:
 *
 * - `scope`, an opaque partition key the host chooses, first in every key.
 * - `position`, the order a row was first put in its scope. List reads
 *   return rows by it, as the memory store lists its records, and a row
 *   put again keeps its position.
 *
 * A NULL in a nullable column is `null` where the record takes `null`
 * (`last_error`, `error`, `resolution`, and a JSON value that is `null`),
 * and the field left out where the record may leave it out (a Run's
 * `definition` and `links`). No field may be both.
 */

/** One row per `QueueRecord`. Queues are few; they are read whole. */
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

/** One row per `JobRecord`. */
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

/**
 * One row per `RunRecord`. A Run keeps fields its schema does not declare
 * (`RunRecordSchema` admits a Run unchanged): `undeclared` holds them as
 * one JSON object, NULL when there are none. `queue_id` and `status` are
 * plain columns that list reads filter on.
 */
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

/**
 * One row per `SuspensionRecord`. `workflow_suspensions_scope_run_position`
 * serves the read of one Run's Suspensions in order.
 */
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

/**
 * One row per `RunFrame`, keyed by its Run and cursor.
 * `workflow_run_frames_scope_run_position` serves the read of one Run's
 * journal in order, and the delete of a Run's frames.
 */
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
