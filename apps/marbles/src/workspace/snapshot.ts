import { realpathSync } from "node:fs";
import { basename, isAbsolute, relative, sep } from "node:path";
import type { WorkflowStepNode } from "@foundry/workflows/snapshot";
import type { AutomationRecord } from "~/lib/automation";
import type { DefinitionEntry } from "~/lib/definitions/registry";
import type { ExecutionRun } from "~/lib/executions";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import type { RunRecord } from "~/lib/runs/records";
import type { LiveWork } from "~/lib/runs/step-work";
import { decodeTrace, observedTree } from "~/lib/runs/trace";
import type { ActivityRecord } from "~/lib/sandbox/activities";
import { describeTrigger, nextDue } from "~/lib/schedule";
import type { MonitorSpec } from "~/lib/schedule/monitor";
import { describeMonitor } from "~/lib/schedule/monitor";
import type { Schedule } from "~/lib/schedule/triggers";
import type { RunUsageFact, UsageRecords } from "~/lib/usage";
import type {
  CatalogOrigin,
  DashboardSnapshot,
  HarnessActivitySnapshot,
  LiveWorkSnapshot,
  RunSnapshot,
  StepSnapshot,
  TriggerSnapshot,
} from "~/model/dashboard";
import type { JsonValue } from "~/model/json";
import type { LogEntry, SetupLogEntry } from "~/model/log";
import { type InputAttention, isActive } from "~/model/run-status";
import type { KnownRun, MayBelong } from "./usage";
import { stepUsages, totalOf, workspaceUsage } from "./usage";

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

function attentionOf(
  values: readonly (InputAttention | undefined)[]
): InputAttention | undefined {
  if (values.includes("approval")) {
    return "approval";
  }
  return values.includes("question") ? "question" : undefined;
}

export function storedRunSnapshot(record: RunRecord, now: number): RunSnapshot {
  return runSnapshot(record, now, { activities: [], feed: [], work: [] });
}

interface RunSurroundings {
  readonly activities: readonly ActivityRecord[];
  readonly feed: readonly FeedEntrySnapshot[];
  readonly questionOwners?: ReadonlyMap<string, string>;
  readonly usage?: {
    readonly facts: readonly RunUsageFact[];
    readonly mayBelong: MayBelong;
  };
  readonly work: readonly LiveWork[];
}

function liveWorkOn(
  work: readonly LiveWork[],
  waiting: readonly FeedEntrySnapshot[],
  inputAttention: (entry: FeedEntrySnapshot) => InputAttention,
  owners: ReadonlyMap<string, string> = new Map()
): (stepId: string) => readonly LiveWorkSnapshot[] {
  const askedBy = (entry: FeedEntrySnapshot): string | undefined => {
    const session = entry.input?.sessionId;
    return session === undefined ? undefined : (owners.get(session) ?? session);
  };
  return (stepId) =>
    work
      .filter((item) => item.stepId === stepId)
      .map((item) => {
        const attention =
          item.kind === "agent"
            ? attentionOf(
                waiting
                  .filter((entry) => askedBy(entry) === item.sessionId)
                  .map(inputAttention)
              )
            : undefined;
        return attention ? { ...item, attention } : item;
      });
}

function runSnapshot(
  record: RunRecord,
  now: number,
  { activities, feed, questionOwners, usage, work }: RunSurroundings
): RunSnapshot {
  const trace = decodeTrace(record.metadata);
  const steps = trace?.workflow?.steps ?? {};
  const active = isActive(record.status);
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
  const usageAt = usage && stepUsages(usage.facts, usage.mayBelong);
  const workOn = liveWorkOn(
    active ? work : [],
    waiting,
    inputAttention,
    questionOwners
  );
  const interactionOn = (
    stepId: string
  ): Pick<StepSnapshot, "awaiting" | "work"> => {
    const live = workOn(stepId);
    const awaiting = active
      ? feed
          .filter(
            (entry) =>
              entry.run === record.id &&
              entry.step === stepId &&
              entry.kind === "input" &&
              entry.input?.status === "open"
          )
          .map((entry) => entry.id)
      : [];
    return {
      ...(awaiting.length > 0 ? { awaiting } : {}),
      ...(live.length > 0 ? { work: live } : {}),
    };
  };
  const stepNode = (
    node: WorkflowStepNode,
    parent: readonly string[]
  ): StepSnapshot => {
    const path = [...parent, node.name];
    const step = steps[node.key];
    let status: StepSnapshot["status"] | "pending" | "aborted" =
      step?.status ?? "queued";
    if (status === "pending") {
      status = "queued";
    }
    if (status === "aborted") {
      status = "cancelled";
    }
    const children = (node.children ?? []).map((child) =>
      stepNode(child, path)
    );
    const used = usageAt?.(path);
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
      ...interactionOn(node.key),
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
    steps: observedTree(record.snapshot.steps, steps).map((node) =>
      stepNode(node, [])
    ),
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

function catalogOrigin(
  origin: string | undefined,
  root: string,
  workspaceId: string | undefined
): CatalogOrigin | undefined {
  if (origin === undefined) {
    return;
  }
  const colon = origin.lastIndexOf(":");
  const file = colon > 0 ? origin.slice(0, colon) : origin;
  let canonical: string;
  try {
    canonical = realpathSync(file) + origin.slice(file.length);
  } catch {
    canonical = origin;
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

function queuedSnapshot(run: ExecutionRun, now: number): RunSnapshot {
  const queuedAt = Date.parse(run.timestamps.queuedAt);
  return {
    definitionId: run.name,
    elapsed: elapsed(queuedAt, now),
    id: run.id,
    input: json(run.input),
    name: run.name,
    started: new Date(queuedAt).toLocaleString(),
    status: run.status === "running" ? "running" : "queued",
    steps: [],
    triggerId: run.correlation.triggerId,
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

function nextDueAt(
  schedule: Schedule,
  latest: RunRecord | undefined,
  { nextDue: due, startedAt }: Pick<SnapshotOptions, "nextDue" | "startedAt">
): number | undefined {
  if (due?.has(schedule.key)) {
    return due.get(schedule.key) ?? undefined;
  }
  return nextDue(
    schedule,
    latest?.timestamps.completedAt ??
      latest?.timestamps.failedAt ??
      schedule.registeredAt ??
      startedAt
  );
}

export interface OtherWorkspaces {
  readonly runs: readonly RunSnapshot[];
  readonly triggers: readonly TriggerSnapshot[];
}

export interface SnapshotOptions {
  readonly activities?: readonly ActivityRecord[];
  readonly automationErrors?: Readonly<Record<string, string>>;
  readonly automations?: readonly AutomationRecord[];
  readonly definitions: readonly DefinitionEntry[];
  readonly diagnostics?: readonly LogEntry[];
  readonly feed?: readonly FeedEntrySnapshot[];
  readonly live?: ReadonlyMap<string, readonly LiveWork[]>;
  readonly monitors: ReadonlyMap<string, { readonly source: MonitorSpec }>;
  readonly nextDue?: ReadonlyMap<string, number | null>;
  readonly now?: number;
  readonly others?: OtherWorkspaces;
  readonly questionOwners?: ReadonlyMap<string, string>;
  readonly queued?: readonly ExecutionRun[];
  readonly root: string;
  readonly schedules: readonly Schedule[];
  readonly setupLogs?: readonly SetupLogEntry[];
  readonly startedAt: number;
  readonly status: string;
  readonly usage?: UsageRecords;
  readonly workspaceId?: string;
}

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
  const dispatched = new Set(records.map((record) => record.id));
  const queued = (options.queued ?? [])
    .filter(
      (run) =>
        !dispatched.has(run.id) &&
        (run.status === "queued" ||
          (run.kind === "workflow" && run.status === "running"))
    )
    .map((run) => queuedSnapshot(run, now))
    .reverse();
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
  const own = sorted.map((record) =>
    runSnapshot(record, now, {
      activities: options.activities ?? [],
      feed,
      ...(options.questionOwners === undefined
        ? {}
        : { questionOwners: options.questionOwners }),
      ...(usage
        ? {
            usage: {
              facts: usage.byRun.get(record.id) ?? [],
              mayBelong: usage.mayBelongTo(record.id),
            },
          }
        : {}),
      work: options.live?.get(record.id) ?? [],
    })
  );
  const runs = [
    ...queued,
    ...[...own, ...(options.others?.runs ?? [])].sort(
      (a, b) => (b.timing?.createdAt ?? 0) - (a.timing?.createdAt ?? 0)
    ),
  ];
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
    const nextAt = nextDueAt(schedule, latest, options);
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
      ...(nextAt === undefined
        ? {}
        : { next: new Date(nextAt).toLocaleString(), nextAt }),
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
  triggers.push(...(options.others?.triggers ?? []));
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
