import { z } from "zod";

import type { JsonValue } from "./json-value";
import { isJsonValue, isPlainRecord } from "./json-value";
import {
  anyNumber,
  anyValue,
  counter,
  JSON_VALUE_MESSAGE,
  jsonSafe,
  type ReadonlyArraySchema,
  readonlyArray,
  recordOf,
  stringList,
  timestamp,
  unknownRecord,
} from "./record-fields";

/**
 * The workflows records: every shape the execution stores persist or return,
 * and the snapshot and channel-event values those records embed. Each record
 * type is inferred from its schema; this module is their single definition.
 *
 * Decoding keeps the rules these records had before they moved to Zod:
 *   - an unconstrained number admits NaN and ±Infinity; ids, timestamps, and
 *     counters are finite
 *   - a required `unknown` field may be absent, as JSON drops `undefined`
 *   - readonly arrays are readonly in type only; decoding never freezes
 */

/** JSON-safe value accepted at persistence and transport seams. */
export const JsonValueSchema = z.custom<JsonValue>(
  isJsonValue,
  JSON_VALUE_MESSAGE
);

/** Captured error data, carried by failed steps, Runs, and Queues. */
export const ErrorShapeSchema = z.object({
  message: z.string(),
  name: z.string(),
  stack: z.string().optional(),
});
export type ErrorShape = z.infer<typeof ErrorShapeSchema>;

// ── Snapshot ──

/**
 * Step-level status. Distinct from `RunStatus` (run-level) — a Run
 * can be `queued` while its steps are `pending`, etc.
 *
 *   - `pending`   seeded when a workflow dispatches; before `started`
 *   - `running`   step is currently executing
 *   - `complete`  step returned a value
 *   - `failed`    step threw or bailed
 *   - `skipped`   branch arm not taken (writer: composer)
 *   - `suspended` step is parked awaiting `resume`
 *   - `aborted`   step interrupted by cancellation
 *   - `paused`    operator-paused mid-flight; resumes back to `running`
 */
export const StepStatusSchema = z.enum([
  "pending",
  "running",
  "complete",
  "failed",
  "skipped",
  "suspended",
  "aborted",
  "paused",
]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

/**
 * A node in the workflow's structural tree. Carries no live status —
 * status lives in the flat `steps` map under the same `key`.
 */
const workflowStepNodeFields = {
  index: anyNumber,
  key: z.string(),
  name: z.string(),
};

/**
 * TypeScript cannot reliably infer a self-referencing schema, so only the
 * recursive `children` edge is named here; every other field is inferred.
 */
export type WorkflowStepNode = z.infer<
  z.ZodObject<typeof workflowStepNodeFields>
> & {
  readonly children?: readonly WorkflowStepNode[];
};

/** The node's object shape, with `children` recursing into the node schema. */
export interface WorkflowStepNodeShape
  extends Readonly<typeof workflowStepNodeFields> {
  readonly children: z.ZodOptional<
    ReadonlyArraySchema<WorkflowStepNodeObjectSchema>
  >;
}

/** A `z.ZodObject` at runtime: its output is the node, its `shape` the fields. */
export interface WorkflowStepNodeObjectSchema
  extends z.ZodType<WorkflowStepNode> {
  readonly shape: WorkflowStepNodeShape;
}

export const WorkflowStepNodeSchema: WorkflowStepNodeObjectSchema = z.object({
  // Declared first: decoded nodes keep the key order they have always had.
  get children() {
    return readonlyArray(WorkflowStepNodeSchema).optional();
  },
  ...workflowStepNodeFields,
});

/**
 * The structural plan + cursor. Nullable — single-step Runs (Step.run
 * without a Workflow wrapper) leave this null and just populate
 * `steps`/`results`.
 */
export const WorkflowSnapshotSchema = z.object({
  cursor: z.string().nullable(),
  input: anyValue,
  name: z.string(),
  steps: readonlyArray(WorkflowStepNodeSchema),
});
export type WorkflowSnapshot = z.infer<typeof WorkflowSnapshotSchema>;

/** Per-step snapshot, flat by namespaced key (no nested children). */
export const StepSnapshotSchema = z.object({
  attempt: anyNumber,
  bail: z.unknown().optional(),
  completedAt: z.string().optional(),
  durationMs: anyNumber.optional(),
  error: ErrorShapeSchema.optional(),
  name: z.string(),
  namespace: z.string(),
  output: z.unknown().optional(),
  progress: anyNumber.optional(),
  startedAt: z.string().optional(),
  status: StepStatusSchema,
  suspendedAt: z.string().optional(),
  suspension: z
    .object({
      meta: unknownRecord.optional(),
      name: z.string(),
      reason: z.string(),
      suspendedAt: z.string(),
    })
    .optional(),
});
export type StepSnapshot = z.infer<typeof StepSnapshotSchema>;

export const SnapshotStateSchema = z.object({
  results: unknownRecord,
  steps: recordOf(StepSnapshotSchema),
  updatedAt: z.string(),
  workflow: WorkflowSnapshotSchema.nullable(),
});
export type SnapshotState = z.infer<typeof SnapshotStateSchema>;

// ── Channel events ──

/** Suspension metadata payload (carried on `step.suspended`). */
export const SuspensionStateSchema = z.object({
  kind: z.string().optional(),
  meta: unknownRecord.optional(),
  name: z.string(),
  occurrence: counter.optional(),
  reason: z.string(),
  request: z.unknown().optional(),
  stepPath: stringList.optional(),
  suspendedAt: z.string(),
});
export type SuspensionState = z.infer<typeof SuspensionStateSchema>;

const lifecycleFields = {
  at: z.string(),
  attempt: anyNumber,
  name: z.string(),
  path: stringList,
};

export const StepStartedEvent = z.object({
  _tag: z.literal("step.started"),
  ...lifecycleFields,
});
export const StepCompleteEvent = z.object({
  _tag: z.literal("step.complete"),
  ...lifecycleFields,
  value: anyValue,
});
export const StepFailedEvent = z.object({
  _tag: z.literal("step.failed"),
  ...lifecycleFields,
  error: ErrorShapeSchema,
});
export const StepBailedEvent = z.object({
  _tag: z.literal("step.bailed"),
  ...lifecycleFields,
  bail: anyValue,
});
export const StepSuspendedEvent = z.object({
  _tag: z.literal("step.suspended"),
  ...lifecycleFields,
  suspension: SuspensionStateSchema,
});
export const StepPausedEvent = z.object({
  _tag: z.literal("step.paused"),
  ...lifecycleFields,
  reason: z.string().optional(),
});
export const StepResumedEvent = z.object({
  _tag: z.literal("step.resumed"),
  ...lifecycleFields,
});
export const StepSkippedEvent = z.object({
  _tag: z.literal("step.skipped"),
  ...lifecycleFields,
  reason: z.string().optional(),
});
export const StepAbortedEvent = z.object({
  _tag: z.literal("step.aborted"),
  ...lifecycleFields,
  reason: z.unknown().optional(),
});
export const StepProgressEvent = z.object({
  _tag: z.literal("step.progress"),
  ...lifecycleFields,
  value: anyNumber,
});
export const StepResolvedEvent = z.object({
  _tag: z.literal("step.resolved"),
  ...lifecycleFields,
  suspensionName: z.string(),
  value: anyValue,
});
export const CustomEvent = z.object({
  _tag: z.literal("custom"),
  at: z.string(),
  path: stringList,
  payload: z.unknown().optional(),
  stepId: z.string(),
  type: z.string(),
});

export const ChannelEventSchema = z.discriminatedUnion("_tag", [
  StepStartedEvent,
  StepCompleteEvent,
  StepFailedEvent,
  StepBailedEvent,
  StepSuspendedEvent,
  StepPausedEvent,
  StepResumedEvent,
  StepSkippedEvent,
  StepAbortedEvent,
  StepResolvedEvent,
  StepProgressEvent,
  CustomEvent,
]);
export type ChannelEvent = z.infer<typeof ChannelEventSchema>;

// ── Execution records ──

const JobIdSchema = z.string().regex(/^jb-.+/);
const RunIdSchema = z.string().regex(/^rn-.+/);
const SuspensionIdSchema = z.string().regex(/^su-.+/);

/** Host-owned JSON-safe data keyed by namespace. */
const ExtensionsSchema = recordOf(JsonValueSchema);

export const DefinitionReferenceSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
});
export type DefinitionReference = z.infer<typeof DefinitionReferenceSchema>;

export const JobLinksSchema = z.object({
  invocationId: z.string().optional(),
  parentJobId: JobIdSchema.optional(),
  principalId: z.string().optional(),
  sessionId: z.string().optional(),
  subjectId: z.string().optional(),
  taskId: z.string().optional(),
});
export type JobLinks = z.infer<typeof JobLinksSchema>;

export const RunLinksSchema = z.object({
  invocationId: z.string().optional(),
  jobId: JobIdSchema.optional(),
  parentRunId: RunIdSchema.optional(),
  principalId: z.string().optional(),
  sessionId: z.string().optional(),
  subjectId: z.string().optional(),
});
export type RunLinks = z.infer<typeof RunLinksSchema>;

/** Operating state of a queue, distinct from an individual run outcome. */
export const QUEUE_STATUSES = [
  "active",
  "paused",
  "draining",
  "stopped",
] as const;
export const QueueStatusSchema = z.enum(QUEUE_STATUSES);
export type QueueStatus = z.infer<typeof QueueStatusSchema>;

export const QueueRecordSchema = z.object({
  createdAt: timestamp,
  extensions: ExtensionsSchema,
  id: z.string(),
  lastError: ErrorShapeSchema.nullable(),
  name: z.string(),
  status: QueueStatusSchema,
});
export type QueueRecord = z.infer<typeof QueueRecordSchema>;

export const JOB_STATUSES = [
  "pending",
  "active",
  "waiting",
  "complete",
  "failed",
  "cancelled",
] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobRecordSchema = z.object({
  definition: DefinitionReferenceSchema,
  id: JobIdSchema,
  input: JsonValueSchema,
  links: JobLinksSchema,
  status: JobStatusSchema,
  timestamps: z.object({
    cancelledAt: timestamp.nullable(),
    completedAt: timestamp.nullable(),
    createdAt: timestamp,
    failedAt: timestamp.nullable(),
  }),
});
export type JobRecord = z.infer<typeof JobRecordSchema>;

/** Lifecycle status owned by the workflows execution boundary. */
export const RUN_STATUSES = [
  "queued",
  "running",
  "suspended",
  "complete",
  "failed",
  "cancelled",
] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

const RunTimestampsSchema = z.object({
  completedAt: timestamp.nullable(),
  createdAt: timestamp,
  failedAt: timestamp.nullable(),
  startedAt: timestamp.nullable(),
});
export type RunTimestamps = z.infer<typeof RunTimestampsSchema>;

/**
 * The declared fields of a persisted Run: the shape a Run table derives from.
 * `definition` and `links` may be absent on records written before they were
 * introduced. `input`, `output`, and `metadata` are JSON-safe but stay typed
 * as `unknown`.
 *
 * This is the shape, not the decoder: parsed alone it drops undeclared keys,
 * rejects an explicit `undefined`, and skips the admission rules. Decode a
 * Run with `RunRecordSchema`.
 */
export const RunRecordShapeSchema = z.object({
  definition: DefinitionReferenceSchema.exactOptional(),
  error: ErrorShapeSchema.nullable(),
  extensions: ExtensionsSchema,
  id: RunIdSchema,
  input: jsonSafe,
  links: RunLinksSchema.exactOptional(),
  metadata: recordOf(jsonSafe),
  output: jsonSafe,
  queueId: z.string(),
  snapshot: WorkflowSnapshotSchema.extend({ input: jsonSafe }),
  status: RunStatusSchema,
  step: z.string(),
  tags: recordOf(z.string()),
  timestamps: RunTimestampsSchema,
});
export type RunRecord = z.infer<typeof RunRecordShapeSchema>;

/** The shape as admitted at runtime, where an explicit `undefined` means absent. */
const AdmittedRunFieldsSchema = RunRecordShapeSchema.extend({
  definition: DefinitionReferenceSchema.optional(),
  links: RunLinksSchema.optional(),
});

/**
 * A Run is admitted as a whole: plain objects for the record and its nested
 * data, JSON-safe containers checked before their entries, then the declared
 * fields. Admission returns the record unchanged, so fields it does not
 * declare survive.
 */
function isRunRecord(value: unknown): value is RunRecord {
  return (
    isPlainRecord(value) &&
    isPlainRecord(value.timestamps) &&
    (value.error === null || isPlainRecord(value.error)) &&
    isPlainRecord(value.tags) &&
    isJsonContainer(value.metadata) &&
    isJsonContainer(value.extensions) &&
    isJsonValue(value.snapshot) &&
    isPlainRecord(value.snapshot) &&
    Object.hasOwn(value.snapshot, "input") &&
    AdmittedRunFieldsSchema.safeParse(value).success
  );
}

function isJsonContainer(value: unknown): boolean {
  return isPlainRecord(value) && isJsonValue(value);
}

export const RunRecordSchema = z.custom<RunRecord>(
  isRunRecord,
  "Expected a valid, JSON-safe Run record"
);

// ── Persisted Run metadata ──

const WorkflowTelemetrySchema = z.object({
  logs: readonlyArray(
    z.object({
      at: z.string(),
      level: z.enum(["debug", "info", "warn", "error"]),
      message: z.string(),
      metadata: unknownRecord.optional(),
      path: stringList.optional(),
      stepId: z.string().optional(),
    })
  ),
  metrics: z.object({
    updatedAt: z.string(),
    values: recordOf(anyNumber),
  }),
});

/**
 * The `metadata.workflow` blob: the workflow state fortified with the
 * `runId`/`step` ornaments the writer stamps. Most fields are optional because
 * the insert-time row carries only `{ input, steps, tree }` before the first
 * reactive write fills in the rest.
 */
export const PersistedWorkflowSchema = z.object({
  attempt: anyNumber.optional(),
  completedAt: z.string().optional(),
  createdAt: z.string().optional(),
  error: ErrorShapeSchema.optional(),
  input: z.unknown().optional(),
  metadata: unknownRecord.optional(),
  output: z.unknown().optional(),
  runId: z.string().optional(),
  startedAt: z.string().optional(),
  status: RunStatusSchema.optional(),
  step: z.string().optional(),
  steps: recordOf(StepSnapshotSchema).optional(),
  suspendedAt: z.string().optional(),
  suspension: SuspensionStateSchema.optional(),
  tags: recordOf(z.string()).optional(),
  telemetry: WorkflowTelemetrySchema.optional(),
  tree: WorkflowSnapshotSchema.nullable().optional(),
});
export type PersistedWorkflow = z.infer<typeof PersistedWorkflowSchema>;

/**
 * The workflows namespaces of a persisted Run's `metadata`: `workflow` and
 * `stream`. `RunRecord.metadata` stays open for other namespaces. The writer
 * validates this blob with encodePersistedMetadata, and readers decode it
 * through decodeMetadataValue or workflowTraceFactsFromMetadata.
 */
export const PersistedMetadataSchema = z.object({
  stream: readonlyArray(ChannelEventSchema).optional(),
  workflow: PersistedWorkflowSchema.nullable().optional(),
});
export type PersistedMetadata = z.infer<typeof PersistedMetadataSchema>;

// ── Suspensions and the Run journal ──

export const SUSPENSION_STATUSES = [
  "pending",
  "resolved",
  "cancelled",
] as const;
export const SuspensionStatusSchema = z.enum(SUSPENSION_STATUSES);
export type SuspensionStatus = z.infer<typeof SuspensionStatusSchema>;

export const SuspensionRecordSchema = z.object({
  id: SuspensionIdSchema,
  kind: z.string(),
  name: z.string(),
  occurrence: counter,
  reason: z.string(),
  request: JsonValueSchema,
  resolution: JsonValueSchema.nullable(),
  revision: counter,
  runId: RunIdSchema,
  status: SuspensionStatusSchema,
  stepPath: stringList,
  timestamps: z.object({
    cancelledAt: timestamp.nullable(),
    createdAt: timestamp,
    resolvedAt: timestamp.nullable(),
  }),
});
export type SuspensionRecord = z.infer<typeof SuspensionRecordSchema>;

export const RunFramePayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("output"), value: JsonValueSchema }),
  z.object({ kind: z.literal("progress"), value: z.number() }),
  z.object({ kind: z.literal("log"), value: JsonValueSchema }),
  z.object({ kind: z.literal("lifecycle"), value: JsonValueSchema }),
  z.object({ kind: z.literal("suspension"), value: SuspensionRecordSchema }),
]);
export type RunFramePayload = z.infer<typeof RunFramePayloadSchema>;

/** One retained journal entry for a Run, ordered by `cursor`. */
export const RunFrameSchema = z
  .object({
    at: timestamp,
    cursor: counter,
    payload: RunFramePayloadSchema,
    runId: RunIdSchema,
  })
  .refine(
    (frame) =>
      frame.payload.kind !== "suspension" ||
      frame.runId === frame.payload.value.runId,
    "Suspension frame and payload must share one Run"
  );
export type RunFrame = z.infer<typeof RunFrameSchema>;

// ── Run facts ──

/**
 * What happened to a Run, one past-tense name per change of its lifecycle:
 * filed (`queued`), set running (`started`), suspended on a Suspension
 * (`parked`), queued again once its Suspension resolved (`resumed`), ended
 * (`completed`, `failed`, `cancelled`), and deleted (`removed`).
 */
export const RUN_FACT_TYPES = [
  "run.queued",
  "run.started",
  "run.parked",
  "run.resumed",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.removed",
] as const;
export const RunFactTypeSchema = z.enum(RUN_FACT_TYPES);
export type RunFactType = z.infer<typeof RunFactTypeSchema>;

/**
 * A change fact: one change `ExecutionCoordinator` made to a Run, carried in
 * the store write that makes it (`WorkflowStoreWrite.facts`). `id` names the
 * fact itself and `at` is when the coordinator built it, an ISO time. A
 * handler reads the Run by `runId` for anything more.
 */
export const RunFactSchema = z.strictObject({
  at: z.iso.datetime(),
  id: z.string().min(1),
  queueId: z.string(),
  runId: RunIdSchema,
  type: RunFactTypeSchema,
});
export type RunFact = z.infer<typeof RunFactSchema>;

export const ORCHESTRATOR_STORE_SNAPSHOT_VERSION = 1 as const;

/** Complete in-memory store image: every record, before cross-checks. */
export const OrchestratorStoreSnapshotSchema = z.object({
  frames: readonlyArray(RunFrameSchema),
  jobs: readonlyArray(JobRecordSchema),
  queues: readonlyArray(QueueRecordSchema),
  runs: readonlyArray(RunRecordSchema),
  suspensions: readonlyArray(SuspensionRecordSchema),
  version: z.literal(ORCHESTRATOR_STORE_SNAPSHOT_VERSION),
});
export type OrchestratorStoreSnapshot = z.infer<
  typeof OrchestratorStoreSnapshotSchema
>;
