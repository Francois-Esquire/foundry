import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { isRecord, readJson } from "~/state/json";
import { alive, holderPid } from "~/state/locks";

/**
 * Everything `quirks status` shows, read straight from the state dir. Pure
 * fs: no engine, no store, no renderer, so it works with no Quirks running.
 * Unreadable files are skipped; the report is advisory, never fatal.
 */

export interface StatusReport {
  readonly root: string;
  readonly workspaces: readonly WorkspaceStatus[];
}

export interface WorkspaceStatus {
  /** A foreground `run` loop wrote heartbeat.json and its pid is alive. */
  readonly alive: boolean;
  readonly config: string | null;
  readonly id: string;
  readonly lastSeen: string | null;
  readonly pid: number | null;
  readonly root: string;
  readonly runs: RunsStatus;
  readonly schedules: readonly ScheduleStatus[];
  readonly sessions: number;
}

export interface ScheduleStatus {
  readonly kind: "monitor" | null;
  readonly lastFinish: string | null;
  readonly lastStatus: string | null;
  readonly name: string;
  readonly nextDue: string | null;
  /** Pid of the live tick holding the lock, if any. */
  readonly running: number | null;
}

export interface RunsStatus {
  /** Newest first, at most five. */
  readonly recent: readonly RunSummary[];
  readonly total: number;
}

export interface RunSummary {
  readonly createdAt: number;
  readonly id: string;
  /** Not settled, and the process that owned it is gone. */
  readonly orphaned: boolean;
  readonly status: string;
  readonly step: string;
}

const TERMINAL = new Set(["complete", "failed", "cancelled"]);
const RECENT = 5;

export function readStatus(stateRoot: string): StatusReport {
  const workspaces = listDirs(stateRoot)
    .map((id) => readWorkspace(join(stateRoot, id)))
    .filter((workspace) => workspace !== undefined);
  return { root: stateRoot, workspaces };
}

function readWorkspace(dir: string): WorkspaceStatus | undefined {
  const meta = readJson(join(dir, "workspace.json"));
  if (!isRecord(meta)) {
    return undefined;
  }
  if (typeof meta.id !== "string" || typeof meta.root !== "string") {
    return undefined;
  }
  const heartbeat = readJson(join(dir, "heartbeat.json"));
  const pid =
    isRecord(heartbeat) && typeof heartbeat.pid === "number"
      ? heartbeat.pid
      : null;
  return {
    alive: pid !== null && alive(pid),
    config: typeof meta.config === "string" ? meta.config : null,
    id: meta.id,
    lastSeen: typeof meta.lastSeen === "string" ? meta.lastSeen : null,
    pid,
    root: meta.root,
    runs: readRuns(join(dir, "runs")),
    schedules: readSchedules(dir),
    sessions: jsonFiles(join(dir, "sessions")).length,
  };
}

/** Recorded schedules, plus any a live lock names that has no history yet. */
function readSchedules(dir: string): ScheduleStatus[] {
  const locks = join(dir, "locks");
  const running = new Map<string, number>();
  for (const name of listFiles(locks)) {
    const holder = holderPid(join(locks, name));
    if (holder !== undefined && alive(holder)) {
      running.set(name, holder);
    }
  }
  const names = new Set([
    ...jsonFiles(join(dir, "schedules")).map((file) => file.slice(0, -5)),
    ...running.keys(),
  ]);
  return [...names].sort().map((name) => {
    const history = readJson(join(dir, "schedules", `${name}.json`));
    const field = (key: string) =>
      isRecord(history) && typeof history[key] === "string"
        ? history[key]
        : null;
    return {
      kind: field("kind") === "monitor" ? "monitor" : null,
      lastFinish: field("lastFinish"),
      lastStatus: field("lastStatus"),
      name,
      nextDue: field("nextDue"),
      running: running.get(name) ?? null,
    };
  });
}

function readRuns(dir: string): RunsStatus {
  const runs = jsonFiles(dir)
    .map((file) => readRun(join(dir, file)))
    .filter((run) => run !== undefined)
    .sort((a, b) => b.createdAt - a.createdAt);
  return { recent: runs.slice(0, RECENT), total: runs.length };
}

function readRun(path: string): RunSummary | undefined {
  const file = readJson(path);
  if (!(isRecord(file) && isRecord(file.run))) {
    return undefined;
  }
  const { run } = file;
  if (
    typeof run.id !== "string" ||
    typeof run.step !== "string" ||
    typeof run.status !== "string" ||
    !isRecord(run.timestamps) ||
    typeof run.timestamps.createdAt !== "number"
  ) {
    return undefined;
  }
  const owner = typeof file.pid === "number" ? file.pid : undefined;
  return {
    createdAt: run.timestamps.createdAt,
    id: run.id,
    orphaned:
      !TERMINAL.has(run.status) && (owner === undefined || !alive(owner)),
    status: run.status,
    step: run.step,
  };
}

function listDirs(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

function jsonFiles(dir: string): string[] {
  return listFiles(dir).filter((name) => name.endsWith(".json"));
}
