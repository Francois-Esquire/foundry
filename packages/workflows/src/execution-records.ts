import { Schema } from "effect";

import type { Extensions } from "./extensions";
import type { WorkflowSnapshot } from "./snapshot";
import { WorkflowSnapshotSchema } from "./snapshot";
import type { ErrorShape, RunStatus } from "./types";

/** JSON-safe value accepted at persistence and transport seams. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const JsonValueSchema = Schema.Unknown.pipe(
  Schema.filter((value): value is JsonValue => isJsonValue(value), {
    message: () => "Expected a finite, acyclic JSON value",
  })
);

/** True only for data that can cross persistence and transport JSON seams. */
export function isJsonValue(value: unknown): value is JsonValue {
  try {
    return checkJsonValue(value, new WeakSet());
  } catch {
    // Proxies and exotic objects may throw while their shape is inspected.
    return false;
  }
}

function checkJsonValue(
  value: unknown,
  ancestors: WeakSet<object>
): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }

  if (ancestors.has(value)) {
    return false;
  }

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (
    (isArray && prototype !== Array.prototype) ||
    (!isArray && prototype !== Object.prototype && prototype !== null)
  ) {
    return false;
  }

  const keys = Reflect.ownKeys(value);
  const enumerableKeys = Object.keys(value);
  if (keys.some((key) => typeof key === "symbol")) {
    return false;
  }
  if (isArray) {
    if (
      enumerableKeys.length !== value.length ||
      keys.length !== enumerableKeys.length + 1 ||
      !keys.includes("length") ||
      enumerableKeys.some((key, index) => key !== String(index))
    ) {
      return false;
    }
  } else if (keys.length !== enumerableKeys.length) {
    return false;
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  ancestors.add(value);
  for (const key of enumerableKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !checkJsonValue(descriptor.value, ancestors)
    ) {
      ancestors.delete(value);
      return false;
    }
  }
  ancestors.delete(value);
  return true;
}

const JobIdSchema = Schema.String.pipe(Schema.pattern(/^jb-.+/));
const RunIdSchema = Schema.String.pipe(Schema.pattern(/^rn-.+/));
const SuspensionIdSchema = Schema.String.pipe(Schema.pattern(/^su-.+/));

export const DefinitionReferenceSchema = Schema.Struct({
  name: Schema.String,
  version: Schema.optional(Schema.String),
});
export type DefinitionReference = Schema.Schema.Type<
  typeof DefinitionReferenceSchema
>;

export const JobLinksSchema = Schema.Struct({
  invocationId: Schema.optional(Schema.String),
  parentJobId: Schema.optional(JobIdSchema),
  principalId: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  subjectId: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
});
export type JobLinks = Schema.Schema.Type<typeof JobLinksSchema>;

export const RunLinksSchema = Schema.Struct({
  invocationId: Schema.optional(Schema.String),
  jobId: Schema.optional(JobIdSchema),
  parentRunId: Schema.optional(RunIdSchema),
  principalId: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  subjectId: Schema.optional(Schema.String),
});
export type RunLinks = Schema.Schema.Type<typeof RunLinksSchema>;

export const JobStatusSchema = Schema.Literal(
  "pending",
  "active",
  "waiting",
  "complete",
  "failed",
  "cancelled"
);
export type JobStatus = Schema.Schema.Type<typeof JobStatusSchema>;

const JobTimestampsSchema = Schema.Struct({
  cancelledAt: Schema.NullOr(Schema.Number.pipe(Schema.finite())),
  completedAt: Schema.NullOr(Schema.Number.pipe(Schema.finite())),
  createdAt: Schema.Number.pipe(Schema.finite()),
  failedAt: Schema.NullOr(Schema.Number.pipe(Schema.finite())),
});

export const JobRecordSchema = Schema.Struct({
  definition: DefinitionReferenceSchema,
  id: JobIdSchema,
  input: JsonValueSchema,
  links: JobLinksSchema,
  status: JobStatusSchema,
  timestamps: JobTimestampsSchema,
});
export type JobRecord = Schema.Schema.Type<typeof JobRecordSchema>;

export function decodeJobRecord(value: unknown): JobRecord {
  return Schema.decodeUnknownSync(JobRecordSchema)(value);
}

export const RunStatusSchema = Schema.Literal(
  "queued",
  "running",
  "suspended",
  "complete",
  "failed",
  "cancelled"
);

export interface RunTimestamps {
  completedAt: number | null;
  createdAt: number;
  failedAt: number | null;
  startedAt: number | null;
}

/**
 * Persisted Run shape. `definition` and `links` remain optional until the
 * orchestrator starts authoring them in Task 03.
 */
export interface RunRecord {
  definition?: DefinitionReference;
  error: ErrorShape | null;
  extensions: Extensions;
  id: string;
  input: unknown;
  links?: RunLinks;
  metadata: Record<string, unknown>;
  output: unknown;
  queueId: string;
  snapshot: WorkflowSnapshot;
  status: RunStatus;
  step: string;
  tags: Record<string, string>;
  timestamps: RunTimestamps;
}

export const RunRecordSchema = Schema.Unknown.pipe(
  Schema.filter((value): value is RunRecord => isRunRecord(value), {
    message: () => "Expected a valid, JSON-safe Run record",
  })
);

export function decodeRunRecord(value: unknown): RunRecord {
  return Schema.decodeUnknownSync(RunRecordSchema)(value);
}

function isRunRecord(value: unknown): value is RunRecord {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (
    typeof value.id !== "string" ||
    !/^rn-.+/.test(value.id) ||
    typeof value.queueId !== "string" ||
    typeof value.step !== "string" ||
    !Schema.is(RunStatusSchema)(value.status) ||
    !isStringRecord(value.tags) ||
    !isJsonValue(value.input) ||
    !isJsonValue(value.output) ||
    !isErrorShape(value.error) ||
    !Schema.is(WorkflowSnapshotSchema)(value.snapshot) ||
    !isJsonValue(value.snapshot) ||
    !isRunTimestamps(value.timestamps) ||
    !isPlainRecord(value.metadata) ||
    !isJsonValue(value.metadata) ||
    !isPlainRecord(value.extensions) ||
    !isJsonValue(value.extensions)
  ) {
    return false;
  }

  if (
    value.definition !== undefined &&
    !Schema.is(DefinitionReferenceSchema)(value.definition)
  ) {
    return false;
  }
  return value.links === undefined || Schema.is(RunLinksSchema)(value.links);
}

function isRunTimestamps(value: unknown): value is RunTimestamps {
  return (
    isPlainRecord(value) &&
    isFiniteNumber(value.createdAt) &&
    isNullableFiniteNumber(value.startedAt) &&
    isNullableFiniteNumber(value.completedAt) &&
    isNullableFiniteNumber(value.failedAt)
  );
}

function isErrorShape(value: unknown): value is ErrorShape | null {
  return (
    value === null ||
    (isPlainRecord(value) &&
      typeof value.name === "string" &&
      typeof value.message === "string" &&
      (value.stack === undefined || typeof value.stack === "string"))
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isPlainRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

export const SuspensionStatusSchema = Schema.Literal(
  "pending",
  "resolved",
  "cancelled"
);
export type SuspensionStatus = Schema.Schema.Type<
  typeof SuspensionStatusSchema
>;

const SuspensionTimestampsSchema = Schema.Struct({
  cancelledAt: Schema.NullOr(Schema.Number.pipe(Schema.finite())),
  createdAt: Schema.Number.pipe(Schema.finite()),
  resolvedAt: Schema.NullOr(Schema.Number.pipe(Schema.finite())),
});

export const SuspensionRecordSchema = Schema.Struct({
  id: SuspensionIdSchema,
  kind: Schema.String,
  name: Schema.String,
  occurrence: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  reason: Schema.String,
  request: JsonValueSchema,
  resolution: Schema.NullOr(JsonValueSchema),
  revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  runId: RunIdSchema,
  status: SuspensionStatusSchema,
  stepPath: Schema.Array(Schema.String),
  timestamps: SuspensionTimestampsSchema,
});
export type SuspensionRecord = Schema.Schema.Type<
  typeof SuspensionRecordSchema
>;

export function decodeSuspensionRecord(value: unknown): SuspensionRecord {
  return Schema.decodeUnknownSync(SuspensionRecordSchema)(value);
}

export const RunFramePayloadSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("output"), value: JsonValueSchema }),
  Schema.Struct({
    kind: Schema.Literal("progress"),
    value: Schema.Number.pipe(Schema.finite()),
  }),
  Schema.Struct({ kind: Schema.Literal("log"), value: JsonValueSchema }),
  Schema.Struct({ kind: Schema.Literal("lifecycle"), value: JsonValueSchema }),
  Schema.Struct({
    kind: Schema.Literal("suspension"),
    value: SuspensionRecordSchema,
  })
);
export type RunFramePayload = Schema.Schema.Type<typeof RunFramePayloadSchema>;

export const RunFrameSchema = Schema.Struct({
  at: Schema.Number.pipe(Schema.finite()),
  cursor: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  payload: RunFramePayloadSchema,
  runId: RunIdSchema,
}).pipe(
  Schema.filter(
    (frame) =>
      frame.payload.kind !== "suspension" ||
      frame.runId === frame.payload.value.runId,
    { message: () => "Suspension frame and payload must share one Run" }
  )
);
export type RunFrame = Schema.Schema.Type<typeof RunFrameSchema>;
