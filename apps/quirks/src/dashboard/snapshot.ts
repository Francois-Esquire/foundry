import { basename } from "node:path";
import type {
  StepSnapshot as ObservedStep,
  WorkflowStepNode,
} from "@foundry/workflows/snapshot";
import { StepSnapshotSchema } from "@foundry/workflows/snapshot";
import type { RunRecord } from "@foundry/workflows/store";
import { Option, Schema } from "effect";
import type { Schedule } from "~/lib/registry";
import { registry } from "~/lib/registry";
import { describeMonitor } from "~/monitor";
import { cadence, clock, nextDue, weekdays } from "~/schedule";
import type {
  DashboardSnapshot,
  JsonValue,
  RunSnapshot,
  StepSnapshot,
  TriggerSnapshot,
} from "~/views/dashboard-model";

const decodeTrace = Schema.decodeUnknownOption(
  Schema.Struct({
    workflow: Schema.optional(
      Schema.Struct({
        steps: Schema.optional(
          Schema.Record({ key: Schema.String, value: StepSnapshotSchema })
        ),
        telemetry: Schema.optional(
          Schema.Struct({
            logs: Schema.Array(
              Schema.Struct({
                at: Schema.String,
                level: Schema.Literal("debug", "info", "warn", "error"),
                message: Schema.String,
                path: Schema.optional(Schema.Array(Schema.String)),
              })
            ),
          })
        ),
      })
    ),
  })
);

function json(value: unknown): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, item: unknown) =>
        typeof item === "bigint" ? String(item) : item
      )
    );
  } catch {
    return String(value);
  }
}

function elapsed(start: number, end: number): string {
  return `${Math.max(0, (end - start) / 1000).toFixed(1)}s`;
}

/** Dynamic graph steps can appear in the trace before the structural plan includes them. */
function observedTree(
  planned: readonly WorkflowStepNode[],
  steps: Readonly<Record<string, ObservedStep>>
): WorkflowStepNode[] {
  const nodes = new Map<
    string,
    WorkflowStepNode & { children: WorkflowStepNode[] }
  >();
  const parents = new Map<string, string>();
  function seed(entries: readonly WorkflowStepNode[], parent?: string) {
    for (const node of entries) {
      nodes.set(node.key, { ...node, children: [] });
      if (parent) {
        parents.set(node.key, parent);
      }
      seed(node.children ?? [], node.key);
    }
  }
  seed(planned);
  for (const [key, step] of Object.entries(steps)) {
    if (!nodes.has(key)) {
      nodes.set(key, { children: [], index: nodes.size, key, name: step.name });
      parents.set(key, step.namespace);
    }
  }
  const roots: WorkflowStepNode[] = [];
  for (const [key, node] of nodes) {
    const parent = nodes.get(parents.get(key) ?? "");
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function runSnapshot(record: RunRecord, now: number): RunSnapshot {
  const trace = Option.getOrUndefined(decodeTrace(record.metadata));
  const steps = trace?.workflow?.steps ?? {};
  const stepNode = (node: WorkflowStepNode): StepSnapshot => {
    const step = steps[node.key];
    let status: StepSnapshot["status"] | "pending" | "aborted" =
      step?.status ?? "queued";
    if (status === "pending") {
      status = "queued";
    }
    if (status === "aborted") {
      status = "cancelled";
    }
    return {
      children: (node.children ?? []).map(stepNode),
      elapsed: step?.startedAt
        ? elapsed(
            Date.parse(step.startedAt),
            step.completedAt ? Date.parse(step.completedAt) : now
          )
        : undefined,
      error: step?.error?.message,
      id: node.key,
      name: node.name,
      result: json(step?.output),
      status,
    };
  };
  const { timestamps } = record;
  return {
    definitionId: record.step,
    elapsed: elapsed(
      timestamps.startedAt ?? timestamps.createdAt,
      timestamps.completedAt ?? timestamps.failedAt ?? now
    ),
    error: record.error?.message,
    id: record.id,
    input: json(record.input),
    logs: trace?.workflow?.telemetry?.logs.map((entry, index) => ({
      id: `${record.id}:log:${index}`,
      level: entry.level,
      message: entry.message,
      stepId: entry.path?.join("."),
      timestamp: entry.at,
    })),
    name: record.step,
    result: json(record.output),
    started: new Date(
      timestamps.startedAt ?? timestamps.createdAt
    ).toLocaleString(),
    status: record.status,
    steps: observedTree(record.snapshot.steps, steps).map(stepNode),
    triggerId:
      typeof record.extensions.triggerId === "string"
        ? record.extensions.triggerId
        : undefined,
  };
}

function description(schedule: Schedule): string {
  const monitor = registry.monitors.get(schedule.name);
  if (monitor) {
    return describeMonitor(monitor);
  }
  const { trigger } = schedule;
  const when =
    trigger.kind === "interval"
      ? `every ${cadence(trigger.ms)}`
      : `${weekdays(trigger.slot).join(", ") || "daily"} at ${clock(trigger.slot)}`;
  return `${schedule.workflow} · ${when}`;
}

export interface SnapshotOptions {
  readonly harnesses: readonly string[];
  readonly lastFinish: ReadonlyMap<string, number>;
  readonly now?: number;
  readonly root: string;
  readonly startedAt: number;
  readonly status: string;
}

/** Adapt runtime records into presentation data; components never access the registry or engine. */
export function dashboardSnapshot(
  records: readonly RunRecord[],
  options: SnapshotOptions
): DashboardSnapshot {
  const now = options.now ?? Date.now();
  const sorted = [...records].sort(
    (a, b) => b.timestamps.createdAt - a.timestamps.createdAt
  );
  const runs = sorted.map((record) => runSnapshot(record, now));
  const triggers = [...registry.schedules.values()].map(
    (schedule): TriggerSnapshot => {
      const latest = sorted.find(
        (run) => run.extensions.triggerId === schedule.name
      );
      const active = sorted.some(
        (run) =>
          run.extensions.triggerId === schedule.name &&
          ["queued", "running", "suspended"].includes(run.status)
      );
      let status: TriggerSnapshot["status"] =
        schedule.kind === "monitor" ? "watching" : "waiting";
      if (latest?.status === "failed") {
        status = "failed";
      }
      if (active) {
        status = "running";
      }
      const finished =
        latest?.timestamps.completedAt ??
        latest?.timestamps.failedAt ??
        options.lastFinish.get(schedule.name) ??
        options.startedAt;
      const liveOnly = registry.monitors.get(schedule.name)?.kind === "ws";
      return {
        configuration: json({
          input: schedule.input,
          monitor: registry.monitors.get(schedule.name),
          trigger: schedule.trigger,
        }),
        description: description(schedule),
        id: schedule.name,
        kind: schedule.kind ?? "schedule",
        name: schedule.name,
        next: liveOnly
          ? "On message"
          : new Date(nextDue(schedule, finished)).toLocaleString(),
        status,
        targetId: schedule.workflow,
      };
    }
  );
  return {
    definitions: [...registry.definitionKinds]
      .filter(([id]) => !registry.monitors.has(id))
      .map(([id, kind]) => ({
        ...registry.definitionOptions.get(id),
        description:
          registry.definitionOptions.get(id)?.description ??
          `Registered ${kind}`,
        id,
        kind,
        name: id,
      })),
    harnesses: options.harnesses,
    mode: "live",
    root: options.root,
    runs,
    status: options.status,
    triggers,
    workspace: basename(options.root),
  };
}
