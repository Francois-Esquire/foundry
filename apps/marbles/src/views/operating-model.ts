import type { LogEntry } from "~/model/log";
import { isPaused } from "~/model/run-status";
import type { UsageTotal } from "~/model/usage";
import type {
  DashboardSelection,
  DashboardSnapshot,
  RunSnapshot,
} from "./dashboard-model";
import { runSelection } from "./dashboard-model";

export type LogLevel = LogEntry["level"];
export const LOG_LEVELS: readonly LogLevel[] = [
  "debug",
  "info",
  "warn",
  "error",
];
export type LogSource = "all" | "host" | "run";
export const LOG_SOURCES: readonly LogSource[] = ["all", "run", "host"];

export interface OperatingLogEntry extends LogEntry {
  readonly runId?: string;
  readonly runName?: string;
  readonly runWorkspace?: string;
  readonly setup?: boolean;
  readonly source: "host" | "run";
}

export interface LogFilter {
  readonly level: LogLevel;
  readonly query: string;
  readonly runId?: string;
  readonly source: LogSource;
}

function time(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function logRun(
  entry: OperatingLogEntry,
  runId: string
): DashboardSelection {
  return runSelection(
    {
      id: runId,
      ...(entry.runWorkspace === undefined
        ? {}
        : { workspace: { id: entry.runWorkspace } }),
    },
    entry.stepId === undefined ? {} : { stepId: entry.stepId }
  );
}

export function operatingLogs(
  snapshot: DashboardSnapshot
): readonly OperatingLogEntry[] {
  const entries: OperatingLogEntry[] = [
    ...(snapshot.diagnostics ?? []).map(
      (entry): OperatingLogEntry => ({ ...entry, source: "host" })
    ),
    ...(snapshot.setupLogs ?? []).map(
      ({ runId, workflow, ...entry }): OperatingLogEntry => ({
        ...entry,
        runId,
        runName:
          snapshot.runs.find((run) => run.id === runId)?.name ?? workflow,
        setup: true,
        source: "run",
      })
    ),
    ...snapshot.runs.flatMap((run) =>
      (run.logs ?? []).map(
        (entry): OperatingLogEntry => ({
          ...entry,
          runId: run.id,
          runName: run.name,
          ...(run.workspace === undefined
            ? {}
            : { runWorkspace: run.workspace.id }),
          source: "run",
        })
      )
    ),
  ];
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        time(a.entry.timestamp) - time(b.entry.timestamp) || a.index - b.index
    )
    .map(({ entry }) => entry);
}

export function filterLogs(
  entries: readonly OperatingLogEntry[],
  filter: LogFilter
): readonly OperatingLogEntry[] {
  const minimum = LOG_LEVELS.indexOf(filter.level);
  const query = filter.query.trim().toLowerCase();
  return entries.filter(
    (entry) =>
      (filter.runId === undefined || entry.runId === filter.runId) &&
      LOG_LEVELS.indexOf(entry.level) >= minimum &&
      (filter.source === "all" || entry.source === filter.source) &&
      (!query ||
        `${entry.message} ${entry.runName ?? ""} ${entry.runId ?? ""} ${entry.stepId ?? ""}`
          .toLowerCase()
          .includes(query))
  );
}

interface RunCounts {
  readonly cancelled: number;
  readonly complete: number;
  readonly failed: number;
  readonly queued: number;
  readonly running: number;
  readonly waiting: number;
}

export interface OperatingStats {
  readonly counts: RunCounts;
  readonly medianQueueMs?: number;
  readonly medianRunMs?: number;
  readonly successRate?: number;
  readonly total: number;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle];
}

function bucket(run: RunSnapshot): keyof RunCounts | undefined {
  if (run.attention || isPaused(run.status)) {
    return "waiting";
  }
  switch (run.status) {
    case "queued":
    case "running":
    case "complete":
    case "failed":
    case "cancelled":
      return run.status;
    default:
      return;
  }
}

export function operatingStats(runs: readonly RunSnapshot[]): OperatingStats {
  const counts = {
    cancelled: 0,
    complete: 0,
    failed: 0,
    queued: 0,
    running: 0,
    waiting: 0,
  };
  for (const run of runs) {
    const key = bucket(run);
    if (key) {
      counts[key] += 1;
    }
  }
  const timed = runs.flatMap((run) => (run.timing ? [run.timing] : []));
  const runMs = median(
    timed.flatMap(({ endedAt, startedAt }) =>
      endedAt !== undefined && startedAt !== undefined
        ? [endedAt - startedAt]
        : []
    )
  );
  const queueMs = median(
    timed.flatMap(({ createdAt, startedAt }) =>
      startedAt === undefined ? [] : [Math.max(0, startedAt - createdAt)]
    )
  );
  const settled = counts.complete + counts.failed;
  return {
    counts,
    ...(runMs === undefined ? {} : { medianRunMs: runMs }),
    ...(queueMs === undefined ? {} : { medianQueueMs: queueMs }),
    ...(settled > 0 ? { successRate: counts.complete / settled } : {}),
    total: runs.length,
  };
}

function usd(total: UsageTotal): UsageTotal {
  return {
    ...total,
    estimated: total.estimated.filter((amount) => amount.currency === "USD"),
    reported: total.reported.filter((amount) => amount.currency === "USD"),
  };
}

export function workflowRankings(snapshot: DashboardSnapshot) {
  const workflows = new Map(
    snapshot.definitions
      .filter((definition) => definition.kind === "workflow")
      .map(({ id, name }) => [id, name])
  );
  const spend = (snapshot.usage?.byWorkflow ?? [])
    .flatMap(({ id, total }) => {
      const name = workflows.get(id);
      const cost = usd(total);
      const amounts = [...cost.reported, ...cost.estimated];
      return name === undefined || amounts.length === 0
        ? []
        : [
            {
              amount: amounts.reduce((sum, line) => sum + line.amount, 0),
              cost,
              id,
              name,
            },
          ];
    })
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));

  const durations = new Map<
    string,
    { id: string; name: string; ms: number; runs: number }
  >();
  for (const { definitionId, timing, workspace } of snapshot.runs) {
    const name = workflows.get(definitionId);
    const { startedAt, endedAt } = timing ?? {};
    if (
      workspace !== undefined ||
      name === undefined ||
      startedAt === undefined ||
      endedAt === undefined ||
      endedAt < startedAt
    ) {
      continue;
    }
    const previous = durations.get(definitionId);
    durations.set(definitionId, {
      id: definitionId,
      ms: (previous?.ms ?? 0) + endedAt - startedAt,
      name,
      runs: (previous?.runs ?? 0) + 1,
    });
  }
  return {
    elapsed: [...durations.values()].sort(
      (a, b) => b.ms - a.ms || a.name.localeCompare(b.name)
    ),
    spend,
  };
}

export interface LatestItem {
  readonly at: number;
  readonly id: string;
  readonly run?: {
    readonly id: string;
    readonly workspace?: { readonly id: string };
  };
  readonly text: string;
}

export function latestActivity(
  snapshot: DashboardSnapshot,
  limit: number
): readonly LatestItem[] {
  const runs = snapshot.runs.flatMap((run): LatestItem[] => {
    const { timing } = run;
    if (!timing) {
      return [];
    }
    const items: LatestItem[] = [
      {
        at: timing.startedAt ?? timing.createdAt,
        id: JSON.stringify([run.workspace?.id ?? null, run.id, "start"]),
        run,
        text: `${run.name} ${timing.startedAt === undefined ? "queued" : "started"}`,
      },
    ];
    if (timing.endedAt !== undefined) {
      items.push({
        at: timing.endedAt,
        id: JSON.stringify([run.workspace?.id ?? null, run.id, "end"]),
        run,
        text: `${run.name} ${run.status}`,
      });
    }
    return items;
  });
  const feed = snapshot.feed
    .filter(
      (entry) =>
        snapshot.workspaceId === undefined ||
        entry.workspace.id === snapshot.workspaceId
    )
    .map(
      (entry): LatestItem => ({
        at: time(entry.postedAt),
        id: JSON.stringify(["feed", entry.id]),
        run: { id: entry.run },
        text: `${entry.kind}: ${entry.title}`,
      })
    );
  return [...runs, ...feed].sort((a, b) => b.at - a.at).slice(0, limit);
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const TENTH = SECOND / 10;
const SECONDS_PER_MINUTE = MINUTE / SECOND;

export function duration(ms: number): string {
  const millis = Math.round(ms);
  if (millis < SECOND) {
    return `${millis}ms`;
  }
  const tenths = Math.round(ms / TENTH);
  if (tenths < MINUTE / TENTH) {
    return `${(tenths / 10).toFixed(1)}s`;
  }
  const total = Math.round(ms / SECOND);
  const minutes = Math.floor(total / SECONDS_PER_MINUTE);
  const seconds = total % SECONDS_PER_MINUTE;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
