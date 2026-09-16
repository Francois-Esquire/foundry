import { Schema } from "effect";
import { ErrorShapeSchema } from "./channels";
import {
  InconsistentStoreSnapshotError,
  InvalidStoreSnapshotError,
  UnsupportedStoreSnapshotVersionError,
} from "./errors";
import type {
  JobRecord,
  RunFrame,
  RunRecord,
  SuspensionRecord,
} from "./execution-records";
import {
  JobRecordSchema,
  JsonValueSchema,
  RunFrameSchema,
  RunRecordSchema,
  SuspensionRecordSchema,
} from "./execution-records";
import { createExtensions } from "./extensions";
import { decodeRunFrameSequence } from "./run-journal";
import type { QueueRecord } from "./store";

export const ORCHESTRATOR_STORE_SNAPSHOT_VERSION = 1 as const;

const QueueRecordSchema = Schema.Struct({
  createdAt: Schema.Number.pipe(Schema.finite()),
  extensions: Schema.Record({ key: Schema.String, value: JsonValueSchema }),
  id: Schema.String,
  lastError: Schema.NullOr(ErrorShapeSchema),
  name: Schema.String,
  status: Schema.Literal("active", "paused", "draining", "stopped"),
});

const SnapshotShapeSchema = Schema.Struct({
  frames: Schema.Array(RunFrameSchema),
  jobs: Schema.Array(JobRecordSchema),
  queues: Schema.Array(QueueRecordSchema),
  runs: Schema.Array(RunRecordSchema),
  suspensions: Schema.Array(SuspensionRecordSchema),
  version: Schema.Literal(ORCHESTRATOR_STORE_SNAPSHOT_VERSION),
});

export interface OrchestratorStoreSnapshot {
  readonly frames: readonly RunFrame[];
  readonly jobs: readonly JobRecord[];
  readonly queues: readonly QueueRecord[];
  readonly runs: readonly RunRecord[];
  readonly suspensions: readonly SuspensionRecord[];
  readonly version: typeof ORCHESTRATOR_STORE_SNAPSHOT_VERSION;
}

export const OrchestratorStoreSnapshotSchema = SnapshotShapeSchema;

/** Decode, clone, and cross-check a complete in-memory store image. */
export function validateOrchestratorStoreSnapshot(
  input: unknown
): OrchestratorStoreSnapshot {
  if (!(isRecord(input) && "version" in input)) {
    throw new InvalidStoreSnapshotError();
  }
  if (
    typeof input.version !== "number" ||
    !Number.isFinite(input.version) ||
    !Number.isInteger(input.version) ||
    input.version < 1
  ) {
    throw new InvalidStoreSnapshotError(
      "Orchestrator store snapshot version must be a positive integer"
    );
  }
  if (input.version !== ORCHESTRATOR_STORE_SNAPSHOT_VERSION) {
    throw new UnsupportedStoreSnapshotVersionError(input.version);
  }
  if (!Schema.is(JsonValueSchema)(input)) {
    throw new InvalidStoreSnapshotError(
      "Orchestrator store snapshot must be JSON-safe"
    );
  }

  let decoded: OrchestratorStoreSnapshot;
  try {
    decoded = Schema.decodeUnknownSync(OrchestratorStoreSnapshotSchema)(input);
    for (const queue of decoded.queues) {
      createExtensions(queue.extensions);
    }
    for (const run of decoded.runs) {
      createExtensions(run.extensions);
    }
  } catch {
    throw new InvalidStoreSnapshotError(
      "Orchestrator store snapshot contains a malformed record"
    );
  }

  assertConsistent(decoded);
  return JSON.parse(JSON.stringify(decoded)) as OrchestratorStoreSnapshot;
}

function assertConsistent(snapshot: OrchestratorStoreSnapshot): void {
  const queues = uniqueById(snapshot.queues, "Queue");
  const jobs = uniqueById(snapshot.jobs, "Job");
  const runs = uniqueById(snapshot.runs, "Run");
  const suspensions = uniqueById(snapshot.suspensions, "Suspension");

  for (const job of snapshot.jobs) {
    const parentJobId = job.links.parentJobId;
    if (parentJobId !== undefined && !jobs.has(parentJobId)) {
      throw new InconsistentStoreSnapshotError(
        `Job ${job.id} references missing parent Job ${parentJobId}`
      );
    }
  }

  for (const run of snapshot.runs) {
    if (!queues.has(run.queueId)) {
      throw new InconsistentStoreSnapshotError(
        `Run ${run.id} references missing Queue ${run.queueId}`
      );
    }
    const jobId = run.links?.jobId;
    if (jobId !== undefined && !jobs.has(jobId)) {
      throw new InconsistentStoreSnapshotError(
        `Run ${run.id} references missing Job ${jobId}`
      );
    }
    if (jobId !== undefined) {
      const job = jobs.get(jobId);
      if (job) {
        assertSharedLinksMatch(job, run);
      }
    }
    const parentRunId = run.links?.parentRunId;
    if (parentRunId !== undefined && !runs.has(parentRunId)) {
      throw new InconsistentStoreSnapshotError(
        `Run ${run.id} references missing parent Run ${parentRunId}`
      );
    }
  }

  for (const suspension of snapshot.suspensions) {
    const run = runs.get(suspension.runId);
    if (!run) {
      throw new InconsistentStoreSnapshotError(
        `Suspension ${suspension.id} references missing Run ${suspension.runId}`
      );
    }
    if (suspension.status === "pending" && run.status !== "suspended") {
      throw new InconsistentStoreSnapshotError(
        `Pending Suspension ${suspension.id} requires suspended Run ${run.id}`
      );
    }
  }

  for (const job of snapshot.jobs) {
    const activeRuns = snapshot.runs.filter(
      (run) => run.links?.jobId === job.id && isNonTerminalRunStatus(run.status)
    );
    if (activeRuns.length > 1) {
      throw new InconsistentStoreSnapshotError(
        `Job ${job.id} has more than one active Run`
      );
    }
    if (isTerminalJobStatus(job.status) && activeRuns.length > 0) {
      throw new InconsistentStoreSnapshotError(
        `Terminal Job ${job.id} cannot retain active Run ${activeRuns[0]?.id ?? ""}`
      );
    }
  }

  const nextCursor = new Map<string, number>();
  const terminalFrames = new Map<string, "complete" | "failed" | "cancelled">();
  for (const frame of snapshot.frames) {
    const run = runs.get(frame.runId);
    if (!run) {
      throw new InconsistentStoreSnapshotError(
        `Frame references missing Run ${frame.runId}`
      );
    }
    if (
      frame.payload.kind === "suspension" &&
      !suspensions.has(frame.payload.value.id)
    ) {
      throw new InconsistentStoreSnapshotError(
        `Frame references missing Suspension ${frame.payload.value.id}`
      );
    }
    const expected = nextCursor.get(frame.runId) ?? 0;
    if (frame.cursor !== expected) {
      throw new InconsistentStoreSnapshotError(
        `Run ${frame.runId} frame cursor ${frame.cursor} is out of order; expected ${expected}`
      );
    }
    nextCursor.set(frame.runId, expected + 1);

    const terminal = terminalFrameStatus(frame);
    if (terminal === null) {
      continue;
    }
    if (terminalFrames.has(frame.runId)) {
      throw new InconsistentStoreSnapshotError(
        `Run ${frame.runId} has more than one terminal frame`
      );
    }
    if (run.status !== terminal) {
      throw new InconsistentStoreSnapshotError(
        `Run ${frame.runId} status ${run.status} conflicts with terminal frame ${terminal}`
      );
    }
    terminalFrames.set(frame.runId, terminal);
  }
  for (const run of snapshot.runs) {
    try {
      decodeRunFrameSequence(
        run.id,
        snapshot.frames.filter((frame) => frame.runId === run.id)
      );
    } catch (error) {
      throw new InconsistentStoreSnapshotError(
        error instanceof Error
          ? error.message
          : `Run ${run.id} has invalid frames`
      );
    }
  }
}

function terminalFrameStatus(
  frame: RunFrame
): "complete" | "failed" | "cancelled" | null {
  if (frame.payload.kind !== "lifecycle") {
    return null;
  }
  const value = frame.payload.value;
  if (!isRecord(value)) {
    return null;
  }
  const event = value.event;
  return event === "complete" || event === "failed" || event === "cancelled"
    ? event
    : null;
}

function isNonTerminalRunStatus(status: RunRecord["status"]): boolean {
  return status === "queued" || status === "running" || status === "suspended";
}

function isTerminalJobStatus(status: JobRecord["status"]): boolean {
  return status === "complete" || status === "failed" || status === "cancelled";
}

function assertSharedLinksMatch(job: JobRecord, run: RunRecord): void {
  for (const key of [
    "sessionId",
    "invocationId",
    "subjectId",
    "principalId",
  ] as const) {
    const jobValue = job.links[key];
    const runValue = run.links?.[key];
    if (
      jobValue !== undefined &&
      runValue !== undefined &&
      jobValue !== runValue
    ) {
      throw new InconsistentStoreSnapshotError(
        `Run ${run.id} ${key} conflicts with Job ${job.id}`
      );
    }
  }
}

function uniqueById<T extends { readonly id: string }>(
  records: readonly T[],
  label: string
): Map<string, T> {
  const indexed = new Map<string, T>();
  for (const record of records) {
    if (indexed.has(record.id)) {
      throw new InconsistentStoreSnapshotError(
        `${label} identity is duplicated: ${record.id}`
      );
    }
    indexed.set(record.id, record);
  }
  return indexed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
