import type { LogEntry } from "~/model/log";
import type { DashboardSnapshot, RunSnapshot } from "./dashboard-model";
import { isPaused } from "./run-status";

/**
 * What the Overview and Logs tabs read from a snapshot: counts by status,
 * timings, the latest activity, and every log line with where it came from.
 * Pure functions of the snapshot; nothing here is stored or sent anywhere.
 */

export type LogLevel = LogEntry["level"];
export const LOG_LEVELS: readonly LogLevel[] = [
  "debug",
  "info",
  "warn",
  "error",
];
export type LogSource = "all" | "host" | "run";
export const LOG_SOURCES: readonly LogSource[] = ["all", "run", "host"];

/** One line in the Logs tab: a run's telemetry or the host's own. */
export interface OperatingLogEntry extends LogEntry {
  readonly runId?: string;
  readonly runName?: string;
  /** Logged by the run's workflow setup, before any step: it has no step. */
  readonly setup?: boolean;
  readonly source: "host" | "run";
}

/** What the Logs tab shows: lines at or above `level`, from `source`, containing `query`. */
export interface LogFilter {
  readonly level: LogLevel;
  readonly query: string;
  readonly source: LogSource;
}

function time(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Every run's log lines and the host's, oldest first; a stable order for equal times. */
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
      LOG_LEVELS.indexOf(entry.level) >= minimum &&
      (filter.source === "all" || entry.source === filter.source) &&
      (!query ||
        `${entry.message} ${entry.runName ?? ""} ${entry.runId ?? ""} ${entry.stepId ?? ""}`
          .toLowerCase()
          .includes(query))
  );
}

/** Runs by what an operator does about them. */
interface RunCounts {
  readonly cancelled: number;
  readonly complete: number;
  readonly failed: number;
  readonly queued: number;
  readonly running: number;
  /** Paused, suspended, or running and waiting on a person. */
  readonly waiting: number;
}

export interface OperatingStats {
  readonly counts: RunCounts;
  /** Median ms from enqueue to start over runs that started; absent without one. */
  readonly medianQueueMs?: number;
  /** Median ms from start to end over runs that ended; absent without one. */
  readonly medianRunMs?: number;
  /** Completed share of runs that completed or failed; absent without one. */
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

/** One line of the Latest panel: a run changing state or a feed entry. */
export interface LatestItem {
  readonly at: number;
  readonly id: string;
  readonly runId?: string;
  readonly text: string;
}

/** Run starts and endings and this workspace's feed entries, newest first. */
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
        id: `${run.id}:start`,
        runId: run.id,
        text: `${run.name} ${timing.startedAt === undefined ? "queued" : "started"}`,
      },
    ];
    if (timing.endedAt !== undefined) {
      items.push({
        at: timing.endedAt,
        id: `${run.id}:end`,
        runId: run.id,
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
        id: `feed:${entry.id}`,
        runId: entry.run,
        text: `${entry.kind}: ${entry.title}`,
      })
    );
  return [...runs, ...feed].sort((a, b) => b.at - a.at).slice(0, limit);
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** `850ms`, `12.3s`, `4m 05s`. */
export function duration(ms: number): string {
  if (ms < SECOND) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < MINUTE) {
    return `${(ms / SECOND).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / MINUTE);
  const seconds = Math.round((ms % MINUTE) / SECOND);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
