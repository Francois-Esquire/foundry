import type { ChannelEvent } from "./channels";
import type { RecoverableRun } from "./execution-commands";
import { resolveInput } from "./helpers";
import { defineOwnEntry } from "./own-entry";
import type { PersistedMetadata, RunRecord } from "./schema";
import { PersistedMetadataSchema } from "./schema";
import type { StepSnapshot, WorkflowSnapshot } from "./snapshot";
import type { RunStatus } from "./types";
import type { WorkflowPersistence, WorkflowState } from "./workflow";

function decodePersistedMetadata(value: unknown): PersistedMetadata | null {
  const result = PersistedMetadataSchema.safeParse(value);
  return result.success ? result.data : null;
}

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

export function decodeMetadataValue(value: unknown): PersistedMetadata | null {
  if (value === null || value === undefined) {
    return null;
  }
  return decodePersistedMetadata(value);
}

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

export function stepsFromMetadata(
  metadata: PersistedMetadata | null
): Record<string, StepSnapshot> | null {
  return metadata?.workflow?.steps ?? null;
}

export function streamFromMetadata(
  metadata: PersistedMetadata | null
): readonly ChannelEvent[] {
  return metadata?.stream ?? [];
}

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
