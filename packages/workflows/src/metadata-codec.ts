import { Option, Schema } from "effect";

import type { ChannelEvent } from "./channels";
import {
  ChannelEventSchema,
  ErrorShapeSchema,
  SuspensionStateSchema,
} from "./channels";
import { resolveInput } from "./helpers";
import type { StepSnapshot, WorkflowSnapshot } from "./snapshot";
import { StepSnapshotSchema, WorkflowSnapshotSchema } from "./snapshot";
import type { RecoverableRun, RunRecord } from "./store";
import type { RunStatus } from "./types";
import type { WorkflowPersistence, WorkflowState } from "./workflow";

/**
 * Persisted-row metadata codec.
 *
 * The Queue serializes each run's {@link WorkflowState} (plus an append-only
 * event stream) into `runs.metadata`. This module owns the single schema that
 * both sides of that boundary share: {@link encodePersistedMetadata} writes
 * through it and {@link decodeMetadata} reads through it, so the persisted
 * shape can't drift between writer and reader. Every accessor projects from
 * the one decode rather than re-walking the raw JSON.
 */

// Suspension payload on RecoverableRun is exactly the channels suspension
// schema's type — derive it rather than redeclaring a parallel interface.
export type SuspendingMeta = Schema.Schema.Type<typeof SuspensionStateSchema>;

// Run-level status vocabulary owned by workflows. Kept as an Effect-Schema
// literal so the persisted blob decodes with a typed status.
const RunStatusSchema = Schema.Literal(
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled",
  "suspended"
);

const TelemetrySchema = Schema.Struct({
  logs: Schema.Array(
    Schema.Struct({
      at: Schema.String,
      level: Schema.Literal("debug", "info", "warn", "error"),
      message: Schema.String,
      metadata: Schema.optional(
        Schema.Record({ key: Schema.String, value: Schema.Unknown })
      ),
      path: Schema.optional(Schema.Array(Schema.String)),
      stepId: Schema.optional(Schema.String),
    })
  ),
  metrics: Schema.Struct({
    updatedAt: Schema.String,
    values: Schema.Record({ key: Schema.String, value: Schema.Number }),
  }),
});

/**
 * The `metadata.workflow` blob: a {@link WorkflowState} fortified with the
 * `runId`/`step` ornaments the writer stamps. Most fields are optional because
 * the insert-time row carries only `{ input, steps, tree }` before the first
 * reactive write fills in the rest.
 */
const PersistedWorkflowSchema = Schema.Struct({
  attempt: Schema.optional(Schema.Number),
  completedAt: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  error: Schema.optional(ErrorShapeSchema),
  input: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown })
  ),
  output: Schema.optional(Schema.Unknown),
  // Writer ornaments — not part of WorkflowState; carried for fidelity.
  runId: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  status: Schema.optional(RunStatusSchema),
  step: Schema.optional(Schema.String),
  steps: Schema.optional(
    Schema.Record({ key: Schema.String, value: StepSnapshotSchema })
  ),
  suspendedAt: Schema.optional(Schema.String),
  suspension: Schema.optional(SuspensionStateSchema),
  tags: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String })
  ),
  telemetry: Schema.optional(TelemetrySchema),
  tree: Schema.optional(Schema.NullOr(WorkflowSnapshotSchema)),
});
export type PersistedWorkflow = Schema.Schema.Type<
  typeof PersistedWorkflowSchema
>;

const PersistedMetadataSchema = Schema.Struct({
  stream: Schema.optional(Schema.Array(ChannelEventSchema)),
  workflow: Schema.optional(Schema.NullOr(PersistedWorkflowSchema)),
});
type PersistedMetadata = Schema.Schema.Type<typeof PersistedMetadataSchema>;

const decodeMetadataOption = Schema.decodeUnknownOption(
  PersistedMetadataSchema
);
const encodePersistedMetadataSync = Schema.encodeSync(PersistedMetadataSchema);

/** Generic, read-only facts projected from one persisted workflow Run. */
export interface WorkflowTraceFacts {
  readonly steps: Readonly<Record<string, StepSnapshot>>;
  readonly stream: readonly ChannelEvent[];
  readonly workflow: WorkflowSnapshot | null;
}

const emptyWorkflowTraceFacts: WorkflowTraceFacts = Object.freeze({
  steps: Object.freeze({}),
  stream: Object.freeze([]),
  workflow: null,
});

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

/**
 * Decode generic workflow trace facts without exposing the private persisted
 * metadata shape. Invalid input fails closed; valid facts are detached from
 * the caller's Run record and frozen recursively.
 */
export function workflowTraceFactsFromMetadata(
  value: unknown
): WorkflowTraceFacts {
  try {
    const metadata = Option.getOrNull(decodeMetadataOption(value));
    if (!metadata) {
      return emptyWorkflowTraceFacts;
    }
    return deepFreeze(
      structuredClone({
        steps: metadata.workflow?.steps ?? {},
        stream: metadata.stream ?? [],
        workflow: metadata.workflow?.tree ?? null,
      })
    );
  } catch {
    return emptyWorkflowTraceFacts;
  }
}

/** Decode an already-parsed metadata value (not a JSON string) into the typed
 * persisted shape, or `null` if absent or malformed. Used for the pass-through
 * `RecoverableRun.metadata` Record that `adopt` re-seeds from. */
export function decodeMetadataValue(value: unknown): PersistedMetadata | null {
  if (value == null) {
    return null;
  }
  return Option.getOrNull(decodeMetadataOption(value));
}

/** Opaque pass-through parse for the `RecoverableRun.metadata` blob. Preserves
 * the raw shape (including any caller-supplied keys) exactly as persisted. */
export function parseMetadata(
  raw: string | null | undefined
): Record<string, unknown> | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Decode `runs.metadata` into the typed persisted shape, or `null` if absent
 * or malformed. The single schema read all accessors project from. */
export function decodeMetadata(
  raw: string | null | undefined
): PersistedMetadata | null {
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return Option.getOrNull(decodeMetadataOption(parsed));
}

/**
 * Under a `transient` policy, strip the two evidence-carrying fields the gate
 * forbids while keeping every other field so the row still decodes: drop each
 * `steps[*].output`, and null every `step.complete` stream value (the key is
 * kept, not deleted, so `PersistedMetadataSchema` still decodes). The run
 * output is omitted separately by the Queue patch; `custom` events never reach
 * `stream[]` (the Queue's `#eventLogLoop` already filters them).
 */
function gateTransientSteps(
  steps: WorkflowState["steps"]
): WorkflowState["steps"] {
  const gated: Record<string, (typeof steps)[string]> = {};
  for (const [key, snapshot] of Object.entries(steps)) {
    const { output: _output, ...rest } = snapshot;
    gated[key] = rest;
  }
  return gated;
}

function gateTransientStream(
  stream: readonly ChannelEvent[]
): readonly ChannelEvent[] {
  return stream.map((event) =>
    event._tag === "step.complete" ? { ...event, value: null } : event
  );
}

/** Encode the persisted blob through the shared schema so the written shape
 * stays in lockstep with {@link decodeMetadata}. May throw on a non-conforming
 * snapshot; callers wrap in a best-effort effect. Under a `transient` policy
 * the Step outputs and `step.complete` stream values are gated out at this one
 * seam; the default `retained` policy encodes exactly as before. */
export function encodePersistedMetadata(
  workflow: WorkflowState & { readonly runId: string; readonly step: string },
  stream: readonly ChannelEvent[],
  policy: WorkflowPersistence = { results: "retained" }
): Record<string, unknown> {
  if (policy.results === "retained") {
    return encodePersistedMetadataSync({ stream, workflow });
  }
  return encodePersistedMetadataSync({
    stream: gateTransientStream(stream),
    workflow: { ...workflow, steps: gateTransientSteps(workflow.steps) },
  });
}

/** Pull persisted `steps` blob in `Snapshot.seed` shape, or `null` if absent. */
export function stepsFromMetadata(
  metadata: PersistedMetadata | null
): Record<string, StepSnapshot> | null {
  return metadata?.workflow?.steps ?? null;
}

/** Pull persisted append-only event log, or `[]` if absent. */
export function streamFromMetadata(
  metadata: PersistedMetadata | null
): readonly ChannelEvent[] {
  return metadata?.stream ?? [];
}

/** Pull persisted top-level workflow fields in `Workflow.seedState` shape.
 * Falls back to the row's authoritative `status` when metadata is absent. */
export function workflowStateFromMetadata(
  metadata: PersistedMetadata | null,
  rowStatus: RunStatus
): Partial<WorkflowState> & { status: RunStatus } {
  const wf = metadata?.workflow;
  if (!wf) {
    // No metadata — still seed status so accessors agree with the row.
    return { status: rowStatus };
  }
  return { ...wf, status: wf.status ?? rowStatus };
}

/** Translate a raw runs row into RecoverableRun. Used by findRecoverableRuns
 * (bulk, non-terminal) and hydrate (single id, any status). The `lastStatus`
 * field reflects the row's actual status. */
export function rowToRecoverable(row: RunRecord): RecoverableRun {
  const decoded = decodeMetadataValue(row.metadata);
  const raw = row.metadata;
  const wf = decoded?.workflow;
  return {
    id: row.id,
    input: resolveInput(wf?.input, row.input),
    lastStatus: row.status,
    step: row.step,
    ...(wf?.suspension ? { suspension: wf.suspension } : {}),
    extensions: row.extensions,
    metadata: raw,
    ...(row.definition === undefined ? {} : { definition: row.definition }),
    ...(row.links === undefined ? {} : { links: row.links }),
  };
}
