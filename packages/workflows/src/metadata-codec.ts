import type { ChannelEvent } from "./channels";
import { resolveInput } from "./helpers";
import { defineOwnEntry } from "./own-entry";
import type { PersistedMetadata } from "./schema";
import { PersistedMetadataSchema } from "./schema";
import type { StepSnapshot, WorkflowSnapshot } from "./snapshot";
import type { RecoverableRun, RunRecord } from "./store";
import type { RunStatus } from "./types";
import type { WorkflowPersistence, WorkflowState } from "./workflow";

function decodePersistedMetadata(value: unknown): PersistedMetadata | null {
  const result = PersistedMetadataSchema.safeParse(value);
  return result.success ? result.data : null;
}

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
    const metadata = decodePersistedMetadata(value);
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
  if (value === null || value === undefined) {
    return null;
  }
  return decodePersistedMetadata(value);
}

/**
 * Under a `transient` policy, strip the evidence-carrying fields the gate
 * forbids while keeping every other field so the row still decodes: drop the
 * run-level `workflow.output` and each `steps[*].output`, and null every
 * `step.complete` stream value (the key is kept, not deleted, so
 * `PersistedMetadataSchema` still decodes). The Queue patch omits the row's own
 * `output` column; `custom` events never reach `stream[]` (the Queue's
 * `#eventLogLoop` already filters them).
 */
function gateTransientSteps(
  steps: WorkflowState["steps"]
): WorkflowState["steps"] {
  const gated: Record<string, (typeof steps)[string]> = {};
  for (const [key, snapshot] of Object.entries(steps)) {
    const { output: _output, ...rest } = snapshot;
    defineOwnEntry(gated, key, rest);
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
 * stays in lockstep with {@link decodeMetadataValue}. May throw on a non-conforming
 * snapshot; callers wrap in a best-effort effect. Under a `transient` policy
 * the run output, Step outputs, and `step.complete` stream values are gated
 * out at this one seam; the default `retained` policy encodes exactly as before. */
export function encodePersistedMetadata(
  workflow: WorkflowState & { readonly runId: string; readonly step: string },
  stream: readonly ChannelEvent[],
  policy: WorkflowPersistence = { results: "retained" }
): Record<string, unknown> {
  if (policy.results === "retained") {
    return PersistedMetadataSchema.parse({ stream, workflow });
  }
  const { output: _output, ...rest } = workflow;
  return PersistedMetadataSchema.parse({
    stream: gateTransientStream(stream),
    workflow: { ...rest, steps: gateTransientSteps(workflow.steps) },
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
