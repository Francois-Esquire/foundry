import { join } from "node:path";

import { isGone } from "@foundry/lib/process-identity";
import type { StoredRun } from "~/database/runs";
import { readStoredRuns } from "~/database/runs";
import { sessionCounts } from "~/database/sessions";
import type { StoredTick } from "~/database/triggers";
import { readStoredTicks } from "~/database/triggers";
import { recordedWorkspaces } from "~/database/workspaces";
import { TERMINAL_RUN_STATUSES } from "~/lib/run-store";
import type { WorkspaceRecord } from "~/lib/state/workspace";
import type { ProcessHost, ProcessStatus } from "~/process/instance";
import { readProcess } from "~/process/instance";

export interface StatusReport {
  readonly process: ProcessStatus | null;
  readonly root: string;
  readonly workspaces: readonly WorkspaceStatus[];
}

export interface WorkspaceStatus {
  /** A process holds `locks/process` and its pid is alive. */
  readonly alive: boolean;
  readonly config: string | null;
  /** What holds the workspace: its worker, or the daemon itself. */
  readonly host: ProcessHost | null;
  /** The Marbles process starts a worker for it. */
  readonly hosted: boolean;
  readonly id: string;
  readonly lastSeen: string | null;
  readonly pid: number | null;
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

/**
 * The state root as stored: the process claim, and each workspace the
 * registry records with what its directory holds. Reads only; a state root
 * without a database stays without one.
 */
export async function readStatus(stateRoot: string): Promise<StatusReport> {
  const records = await recordedWorkspaces(stateRoot);
  const sessions: ReadonlyMap<string, number> =
    records.length === 0 ? new Map() : await sessionCounts(stateRoot);
  return {
    process: readProcess(stateRoot) ?? null,
    root: stateRoot,
    workspaces: await Promise.all(
      records.map(async (record) =>
        readWorkspaceStatus(
          join(stateRoot, record.id),
          record,
          sessions.get(record.id) ?? 0,
          await readStoredRuns(stateRoot, record.id),
          await readStoredTicks(stateRoot, record.id)
        )
      )
    ),
  };
}

function readWorkspaceStatus(
  dir: string,
  record: WorkspaceRecord,
  sessions: number,
  runs: readonly StoredRun[],
  ticks: readonly StoredTick[]
): WorkspaceStatus {
  const owner = readProcess(dir);
  return {
    alive: owner?.alive ?? false,
    config: record.config,
    host: owner?.alive ? owner.host : null,
    hosted: record.hosted,
    id: record.id,
    lastSeen: record.lastSeen,
    pid: owner?.pid ?? null,
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
