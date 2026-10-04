import { basename } from "node:path";
import type {
  StepSnapshot as ObservedStep,
  WorkflowStepNode,
} from "@foundry/workflows/snapshot";
import { StepSnapshotSchema } from "@foundry/workflows/snapshot";
import type { RunRecord } from "@foundry/workflows/store";
import { Option, Schema } from "effect";
import type { AutomationRecord } from "~/lib/automation/service";
import { catalog } from "~/lib/catalog";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import { describeMonitor } from "~/lib/monitor";
import type { ActivityRecord } from "~/lib/sandbox/activities";
import { cadence, clock, nextDue, weekdays } from "~/lib/schedule";
import type { Schedule } from "~/lib/triggers";
import type {
  DashboardSnapshot,
  HarnessActivitySnapshot,
  InputAttention,
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

function attentionOf(
  values: readonly (InputAttention | undefined)[]
): InputAttention | undefined {
  if (values.includes("approval")) {
    return "approval";
  }
  return values.includes("question") ? "question" : undefined;
}

function runSnapshot(
  record: RunRecord,
  now: number,
  feed: readonly FeedEntrySnapshot[],
  activities: readonly ActivityRecord[]
): RunSnapshot {
  const trace = Option.getOrUndefined(decodeTrace(record.metadata));
  const steps = trace?.workflow?.steps ?? {};
  const waiting =
    record.status === "running"
      ? feed.filter(
          (entry) =>
            entry.run === record.id &&
            entry.kind === "input" &&
            entry.input?.delivery === "live" &&
            entry.input.status === "open"
        )
      : [];
  const inputAttention = (entry: FeedEntrySnapshot): InputAttention =>
    entry.input?.mode === "approval" ? "approval" : "question";
  const attention = attentionOf(waiting.map(inputAttention));
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
    const children = (node.children ?? []).map(stepNode);
    const stepAttention =
      status === "running"
        ? attentionOf([
            ...waiting
              .filter((entry) => entry.step === node.key)
              .map(inputAttention),
            ...children.map((child) => child.attention),
          ])
        : undefined;
    return {
      ...(stepAttention ? { attention: stepAttention } : {}),
      children,
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
    ...(attention ? { attention } : {}),
    activities: activities
      .filter((activity) => activity.source.runId === record.id)
      .map(
        ({ event, source }): HarnessActivitySnapshot => ({
          ...event,
          attention: attentionOf(
            waiting
              .filter(
                (entry) =>
                  entry.input?.sessionId === event.sessionId &&
                  entry.input.activityId === event.id
              )
              .map(inputAttention)
          ),
          stepId: source.path.join("."),
        })
      ),
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
  const monitor = catalog.monitors.get(schedule.key);
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
  readonly activities?: readonly ActivityRecord[];
  readonly automationErrors?: Readonly<Record<string, string>>;
  readonly automations?: readonly AutomationRecord[];
  /** Feed entries from every workspace, newest first. */
  readonly feed?: readonly FeedEntrySnapshot[];
  readonly harnesses: readonly string[];
  readonly lastFinish: ReadonlyMap<string, number>;
  readonly now?: number;
  readonly root: string;
  readonly startedAt: number;
  readonly status: string;
  /** This workspace's id, matching `FeedEntrySnapshot.workspace.id`. */
  readonly workspaceId?: string;
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
  const feed = (options.feed ?? []).filter(
    (entry) =>
      !options.workspaceId || entry.workspace.id === options.workspaceId
  );
  const runs = sorted.map((record) =>
    runSnapshot(record, now, feed, options.activities ?? [])
  );
  const managed = new Map(
    (options.automations ?? []).map((record) => [record.id, record])
  );
  const triggers = [...catalog.schedules.values()].map(
    (schedule): TriggerSnapshot => {
      const automation = managed.get(schedule.key);
      const latest = sorted.find(
        (run) => run.extensions.triggerId === schedule.key
      );
      const active = sorted.some(
        (run) =>
          run.extensions.triggerId === schedule.key &&
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
        options.lastFinish.get(schedule.key) ??
        schedule.registeredAt ??
        options.startedAt;
      return {
        ...(automation
          ? {
              lifetime: "durable" as const,
              managed: true,
              owner: automation.owner.agentId,
            }
          : {}),
        configuration: json(
          automation ?? {
            input: schedule.input,
            monitor: catalog.monitors.get(schedule.key),
            trigger: schedule.trigger,
          }
        ),
        description: automation
          ? `${automation.workflow} · ${automation.source ? "change monitor" : "schedule"} · persists across sessions`
          : description(schedule),
        id: schedule.key,
        kind: schedule.kind,
        name: schedule.label,
        next: new Date(nextDue(schedule, finished)).toLocaleString(),
        status,
        targetId: automation?.workflow ?? schedule.workflow,
      };
    }
  );
  for (const automation of managed.values()) {
    if (automation.enabled) {
      continue;
    }
    triggers.push({
      configuration: json(automation),
      description: `${automation.workflow} · paused`,
      id: automation.id,
      kind: automation.source ? "monitor" : "schedule",
      lifetime: "durable",
      managed: true,
      name: automation.key,
      owner: automation.owner.agentId,
      status: "paused",
      targetId: automation.workflow,
    });
  }
  return {
    definitions: catalog.entries().map((entry) => ({
      description: entry.description ?? `Registered ${entry.kind}`,
      id: entry.name,
      input: entry.input,
      kind: entry.kind,
      name: entry.name,
    })),
    feed: options.feed ?? [],
    harnesses: options.harnesses,
    mode: "live",
    notices: Object.entries(options.automationErrors ?? {}).map(
      ([file, error]) => `Automation unavailable (${file}): ${error}`
    ),
    root: options.root,
    runs,
    status: options.status,
    triggers,
    workspace: basename(options.root),
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
  };
}
