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

const ENTERED: Readonly<
  Record<RunStatus, Exclude<RunEventType, "run.removed" | "run.updated">>
> = {
  cancelled: "run.cancelled",
  complete: "run.completed",
  failed: "run.failed",
  queued: "run.resumed",
  running: "run.started",
  suspended: "run.parked",
};

const RUNTIME_METADATA = new Set(["stream", "workflow", "workflows.execution"]);

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

export function withEvents(
  write: WorkflowStoreWrite,
  events: readonly RunEvent[]
): WorkflowStoreWrite {
  return events.length === 0 ? write : { ...write, events };
}

function fieldOf(run: RunRecord, field: RunField): JsonValue {
  if (field !== "metadata") {
    return run[field] as JsonValue;
  }
  return Object.fromEntries(
    Object.entries(run.metadata).filter(([key]) => !RUNTIME_METADATA.has(key))
  ) as JsonValue;
}

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
