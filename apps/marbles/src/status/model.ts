import {
  isGone,
  type ProcessState,
  processState,
} from "@foundry/lib/process-identity";
import {
  type GenerationRecord,
  type GenerationState,
  readLiveGenerations,
} from "~/database/generations";
import { readLastRecovery } from "~/database/recoveries";
import type { StoredRun } from "~/database/runs";
import { readStoredRuns } from "~/database/runs";
import { sessionCounts } from "~/database/sessions";
import type { StoredTick } from "~/database/triggers";
import { readStoredTicks } from "~/database/triggers";
import { recordedWorkspaces } from "~/database/workspaces";
import type { RecoveryReport } from "~/lib/crash-recovery";
import { TERMINAL_RUN_STATUSES } from "~/lib/run-store";
import type { WorkspaceRecord } from "~/lib/state/workspace";
import type { ProcessStatus } from "~/process/instance";
import { readProcess } from "~/process/instance";

export interface StatusReport {
  readonly generations: readonly GenerationStatus[];
  readonly process: ProcessStatus | null;
  readonly root: string;
  readonly workspaces: readonly WorkspaceStatus[];
}

interface GenerationStatus {
  readonly alive: boolean;
  readonly number: number;
  readonly pid: number;
  readonly state: GenerationState | "cannot tell";
}

export interface WorkspaceStatus {
  readonly alive: boolean;
  readonly config: string | null;
  readonly host: "generation" | null;
  readonly hosted: boolean;
  readonly id: string;
  readonly lastSeen: string | null;
  readonly pid: number | null;
  readonly recovery: RecoveryReport | null;
  readonly root: string;
  readonly runs: RunsStatus;
  readonly schedules: readonly ScheduleStatus[];
  readonly sessions: number;
}

interface ScheduleStatus {
  readonly key: string;
  readonly kind: "monitor" | null;
  readonly lastFinish: string | null;
  readonly lastStatus: string | null;
  readonly name: string;
  readonly nextDue: string | null;
  /** Pid of the live tick holding the lock, if any. */
  readonly running: number | null;
}

interface RunsStatus {
  /** Newest first, at most five. */
  readonly recent: readonly RunSummary[];
  readonly total: number;
}

interface RunSummary {
  readonly createdAt: number;
  readonly id: string;
  /** Not settled, and the process that owned it is gone. */
  readonly orphaned: boolean;
  readonly status: string;
  readonly step: string;
}

const RECENT = 5;

export async function readStatus(stateRoot: string): Promise<StatusReport> {
  const records = await recordedWorkspaces(stateRoot);
  const sessions: ReadonlyMap<string, number> =
    records.length === 0 ? new Map() : await sessionCounts(stateRoot);
  const live = await readLiveGenerations(stateRoot);
  const generations = live.map(generationStatus);
  const index = generations.findIndex(
    (generation) => generation.state === "current" && generation.alive
  );
  const current =
    index === -1
      ? undefined
      : {
          pid: live[index]?.pid ?? 0,
          workspaces: live[index]?.workspaces ?? [],
        };
  return {
    generations,
    process: readProcess(stateRoot) ?? null,
    root: stateRoot,
    workspaces: await Promise.all(
      records.map(async (record) =>
        readWorkspaceStatus(
          current,
          record,
          sessions.get(record.id) ?? 0,
          await readStoredRuns(stateRoot, record.id),
          await readStoredTicks(stateRoot, record.id),
          await readLastRecovery(stateRoot, record.id)
        )
      )
    ),
  };
}

function generationStatus(record: GenerationRecord): GenerationStatus {
  const seen = processOf(record);
  return {
    alive: seen === "running",
    number: record.number,
    pid: record.pid,
    state: seen === "unknown" ? "cannot tell" : record.state,
  };
}

function processOf(record: GenerationRecord): ProcessState {
  if (record.pid <= 0) {
    return "gone";
  }
  if (record.started === null) {
    return "unknown";
  }
  return processState({ pid: record.pid, started: record.started });
}

interface CurrentHost {
  readonly pid: number;
  readonly workspaces: readonly string[];
}

function readWorkspaceStatus(
  current: CurrentHost | undefined,
  record: WorkspaceRecord,
  sessions: number,
  runs: readonly StoredRun[],
  ticks: readonly StoredTick[],
  recovery: RecoveryReport | null
): WorkspaceStatus {
  const host =
    record.hosted && current?.workspaces.includes(record.id) === true
      ? current
      : undefined;
  return {
    alive: host !== undefined,
    config: record.config,
    host: host === undefined ? null : "generation",
    hosted: record.hosted,
    id: record.id,
    lastSeen: record.lastSeen,
    pid: host?.pid ?? null,
    recovery,
    root: record.root,
    runs: runsStatus(runs),
    schedules: ticks.map(scheduleStatus),
    sessions,
  };
}

function scheduleStatus({ key, last, running }: StoredTick): ScheduleStatus {
  return {
    key,
    kind: last?.kind === "monitor" ? "monitor" : null,
    lastFinish: last?.lastFinish ?? null,
    lastStatus: last?.lastStatus ?? null,
    name: last?.label ?? key,
    nextDue: last?.nextDue ?? null,
    running,
  };
}

function runsStatus(stored: readonly StoredRun[]): RunsStatus {
  const runs = stored
    .map(
      (run): RunSummary => ({
        createdAt: run.createdAt,
        id: run.id,
        orphaned:
          !TERMINAL_RUN_STATUSES.has(run.status) &&
          (run.owner === null || isGone(run.owner)),
        status: run.status,
        step: run.step,
      })
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  return { recent: runs.slice(0, RECENT), total: runs.length };
}
