import type { JsonValue } from "./json-value";
import { jsonValuesEqual } from "./json-value";
import type {
  RunEvent,
  RunEventType,
  RunField,
  RunRecord,
  RunStatus,
} from "./schema";
import { RUN_FIELDS } from "./schema";
import type { WorkflowStoreWrite } from "./store/index";

/** The event a Run moving into each status makes, past its filing. */
const ENTERED: Readonly<
  Record<RunStatus, Exclude<RunEventType, "run.removed" | "run.updated">>
> = {
  cancelled: "run.cancelled",
  complete: "run.completed",
  failed: "run.failed",
  // A filed Run queued again: its Suspension resolved, or a host patched
  // it back to its queue.
  queued: "run.resumed",
  running: "run.started",
  suspended: "run.parked",
};

/**
 * The namespaces of a Run's `metadata` the workflows runtime writes as it
 * runs: the persisted workflow state and channel stream (step progress),
 * and the definition and links the coordinator stamps. A change to them is
 * no change to the Run's own data.
 */
const RUNTIME_METADATA = new Set(["stream", "workflow", "workflows.execution"]);

/**
 * The events one change to a Run makes, from the Run as it was (`null`: not
 * filed yet) to the Run as the change leaves it (`null`: deleted), in order:
 *
 * - filing makes `run.queued`, deleting `run.removed`;
 * - a new status makes its lifecycle event (`run.started`, ...);
 * - a change to the Run's own fields (`RUN_FIELDS`) makes `run.updated`
 *   naming them, after the lifecycle event when the status changed too. A
 *   lifecycle change's own timestamps are part of it, not an update.
 *
 * A change that leaves every Run-level field and the status as they were
 * makes none: rewriting the step tree or the workflows metadata is step
 * progress.
 */
export function runEvents(
  before: RunRecord | null,
  after: RunRecord | null
): RunEvent[] {
  if (after === null) {
    return before === null ? [] : [removed(before)];
  }
  if (before === null) {
    return [{ ...base(after), type: "run.queued" }];
  }
  const moved = before.status !== after.status;
  const changed = RUN_FIELDS.filter(
    (field) =>
      !(
        (moved && field === "timestamps") ||
        jsonValuesEqual(fieldOf(before, field), fieldOf(after, field))
      )
  );
  return [
    ...(moved ? [{ ...base(after), type: ENTERED[after.status] }] : []),
    ...(changed.length === 0
      ? []
      : [{ ...base(after), changed, type: "run.updated" as const }]),
  ];
}

/** `write` carrying `events`, in order; left without the field when there are none. */
export function withEvents(
  write: WorkflowStoreWrite,
  events: readonly RunEvent[]
): WorkflowStoreWrite {
  return events.length === 0 ? write : { ...write, events };
}

/** A field as `run.updated` compares it: metadata without the runtime's namespaces. */
function fieldOf(run: RunRecord, field: RunField): JsonValue {
  if (field !== "metadata") {
    return run[field] as JsonValue;
  }
  return Object.fromEntries(
    Object.entries(run.metadata).filter(([key]) => !RUNTIME_METADATA.has(key))
  ) as JsonValue;
}

/** What identifies a deleted Run, which a handler can no longer read. */
function removed(run: RunRecord): RunEvent {
  return {
    ...base(run),
    ...(run.definition === undefined ? {} : { definition: run.definition }),
    ...(run.links === undefined ? {} : { links: run.links }),
    step: run.step,
    tags: run.tags,
    type: "run.removed",
  };
}

function base(run: RunRecord) {
  return {
    at: new Date().toISOString(),
    id: crypto.randomUUID(),
    queueId: run.queueId,
    runId: run.id,
  };
}
