import { realpathSync } from "node:fs";
import { basename, isAbsolute, relative, sep } from "node:path";
import type {
  StepSnapshot as ObservedStep,
  WorkflowStepNode,
} from "@foundry/workflows/snapshot";
import { StepSnapshotSchema } from "@foundry/workflows/snapshot";
import type { RunRecord } from "@foundry/workflows/store";
import { Option, Schema } from "effect";
import type { AutomationRecord } from "~/lib/automation/service";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import type { MonitorSpec } from "~/lib/monitor";
import { describeMonitor } from "~/lib/monitor";
import type { DefinitionEntry } from "~/lib/registry";
import type { ActivityRecord } from "~/lib/sandbox/activities";
import { describeTrigger, nextDue } from "~/lib/schedule";
import type { Schedule } from "~/lib/triggers";
import type { RunUsageFact, UsageRecords } from "~/lib/usage";
import type {
  CatalogOrigin,
  DashboardSnapshot,
  HarnessActivitySnapshot,
  RunSnapshot,
  StepSnapshot,
  TriggerSnapshot,
} from "~/model/dashboard";
import type { JsonValue } from "~/model/json";
import type { LogEntry, SetupLogEntry } from "~/model/log";
import { type InputAttention, isActive } from "~/model/run-status";
import type { KnownRun, MayBelong } from "./usage";
import { stepUsage, totalOf, workspaceUsage } from "./usage";

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
  activities: readonly ActivityRecord[],
  /** The run's facts and what else may be its; absent when usage is not recorded. */
  usage:
    | {
        readonly facts: readonly RunUsageFact[];
        readonly mayBelong: MayBelong;
      }
    | undefined
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
    const used = usage && stepUsage(usage.facts, node.key, usage.mayBelong);
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
      ...(used ? { usage: used } : {}),
    };
  };
  const { timestamps } = record;
  const ended = timestamps.completedAt ?? timestamps.failedAt ?? undefined;
  const started = timestamps.startedAt ?? undefined;
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
      ended ?? now
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
    timing: {
      createdAt: timestamps.createdAt,
      ...(ended === undefined ? {} : { endedAt: ended }),
      ...(started === undefined ? {} : { startedAt: started }),
    },
    triggerId:
      typeof record.extensions.triggerId === "string"
        ? record.extensions.triggerId
        : undefined,
    ...(usage &&
    (usage.facts.length > 0 ||
      usage.mayBelong.unreadable > 0 ||
      usage.mayBelong.unattributed > 0)
      ? {
          usage: totalOf(
            usage.facts,
            usage.mayBelong.unreadable,
            usage.mayBelong.unattributed
          ),
        }
      : {}),
  };
}

/** Where a definition was declared, relative to the workspace root when inside it. */
function catalogOrigin(
  origin: string | undefined,
  root: string,
  workspaceId: string | undefined
): CatalogOrigin | undefined {
  if (origin === undefined) {
    return;
  }
  // The root is canonical; a stack path may still run through a symlink.
  const colon = origin.lastIndexOf(":");
  const file = colon > 0 ? origin.slice(0, colon) : origin;
  let canonical = origin;
  try {
    canonical = realpathSync(file) + origin.slice(file.length);
  } catch {
    // Not on disk (a bundled prebuilt, a test path): compare it as written.
  }
  const local = relative(root, canonical);
  const external =
    local === "" ||
    local === ".." ||
    local.startsWith(`..${sep}`) ||
    isAbsolute(local);
  return {
    external,
    source: external ? canonical : local,
    ...(workspaceId === undefined ? {} : { workspaceId }),
  };
}

function description(
  schedule: Schedule,
  monitor: MonitorSpec | undefined
): string {
  if (monitor) {
    return describeMonitor(monitor);
  }
  return `${schedule.workflow} · ${describeTrigger(schedule.trigger)}`;
}

export interface SnapshotOptions {
  readonly activities?: readonly ActivityRecord[];
  readonly automationErrors?: Readonly<Record<string, string>>;
  readonly automations?: readonly AutomationRecord[];
  /** What can be launched by hand: the engine's `definitions()`. */
  readonly definitions: readonly DefinitionEntry[];
  /** The host's own lines, oldest first, for the logs panel. */
  readonly diagnostics?: readonly LogEntry[];
  /** Feed entries from every workspace, newest first. */
  readonly feed?: readonly FeedEntrySnapshot[];
  readonly lastFinish: ReadonlyMap<string, number>;
  /** What each monitor watches, by trigger key: the engine's `monitors()`. */
  readonly monitors: ReadonlyMap<string, { readonly source: MonitorSpec }>;
  readonly now?: number;
  readonly root: string;
  /** The live triggers: the engine's `schedules()`. */
  readonly schedules: readonly Schedule[];
  /** Workflow setups' lines with their runs, for the logs panel. */
  readonly setupLogs?: readonly SetupLogEntry[];
  readonly startedAt: number;
  readonly status: string;
  /** What agent turns consumed: the engine's `readUsage()`. */
  readonly usage?: UsageRecords;
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
  const usage = options.usage
    ? workspaceUsage(options.usage, options.workspaceId, {
        runs: new Map(
          records.map((record): [string, KnownRun] => {
            const { timestamps } = record;
            const ended = timestamps.completedAt ?? timestamps.failedAt;
            return [
              record.id,
              {
                createdAt: timestamps.createdAt,
                definition: record.step,
                ...(ended === null ? {} : { endedAt: ended }),
              },
            ];
          })
        ),
        workflows: options.definitions.map((entry) => entry.name),
      })
    : undefined;
  const runs = sorted.map((record) =>
    runSnapshot(
      record,
      now,
      feed,
      options.activities ?? [],
      usage && {
        facts: usage.byRun.get(record.id) ?? [],
        mayBelong: usage.mayBelongTo(record.id),
      }
    )
  );
  const managed = new Map(
    (options.automations ?? []).map((record) => [record.id, record])
  );
  const triggers = options.schedules.map((schedule): TriggerSnapshot => {
    const automation = managed.get(schedule.key);
    const latest = sorted.find(
      (run) => run.extensions.triggerId === schedule.key
    );
    const active = sorted.some(
      (run) => run.extensions.triggerId === schedule.key && isActive(run.status)
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
          monitor: options.monitors.get(schedule.key)?.source,
          trigger: schedule.trigger,
        }
      ),
      description: automation
        ? `${automation.workflow} · ${automation.source ? "change monitor" : "schedule"} · persists across sessions`
        : description(schedule, options.monitors.get(schedule.key)?.source),
      id: schedule.key,
      kind: schedule.kind,
      name: schedule.label,
      next: new Date(nextDue(schedule, finished)).toLocaleString(),
      status,
      targetId: automation?.workflow ?? schedule.workflow,
    };
  });
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
    definitions: options.definitions.map((entry) => {
      const origin = catalogOrigin(
        entry.origin,
        options.root,
        options.workspaceId
      );
      return {
        description: entry.description ?? `Registered ${entry.kind}`,
        id: entry.name,
        input: entry.input,
        kind: entry.kind,
        name: entry.name,
        ...(origin ? { origin } : {}),
      };
    }),
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
    feed: options.feed ?? [],
    mode: "live",
    notices: Object.entries(options.automationErrors ?? {}).map(
      ([id, error]) => `Automation unavailable (${id}): ${error}`
    ),
    runs,
    ...(options.setupLogs ? { setupLogs: options.setupLogs } : {}),
    status: options.status,
    triggers,
    ...(usage ? { usage: usage.usage } : {}),
    workspace: basename(options.root),
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
  };
}
