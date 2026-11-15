import { isGone } from "@foundry/lib/process-identity";
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
  /**
   * The engine generations recorded live, newest first: the current one,
   * and any finishing the runs it had when the next took over.
   */
  readonly generations: readonly GenerationStatus[];
  readonly process: ProcessStatus | null;
  readonly root: string;
  readonly workspaces: readonly WorkspaceStatus[];
}

/** One engine generation, as its record says, and whether its process is there. */
export interface GenerationStatus {
  readonly alive: boolean;
  readonly number: number;
  readonly pid: number;
  readonly state: GenerationState;
}

export interface WorkspaceStatus {
  /** It is registered, and the current generation's process is alive. */
  readonly alive: boolean;
  readonly config: string | null;
  /** What hosts the workspace: the current engine generation, while it runs. */
  readonly host: "generation" | null;
  /** Registered with the Marbles process, which hosts it in its current generation. */
  readonly hosted: boolean;
  readonly id: string;
  readonly lastSeen: string | null;
  readonly pid: number | null;
  /** What its last engine start put right after a crash; `null` when none is kept. */
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

/**
 * The state root as stored: the process claim, and each workspace the
 * registry records with what its directory holds. Reads only; a state root
 * without a database stays without one.
 */
export async function readStatus(stateRoot: string): Promise<StatusReport> {
  const records = await recordedWorkspaces(stateRoot);
  const sessions: ReadonlyMap<string, number> =
    records.length === 0 ? new Map() : await sessionCounts(stateRoot);
  const generations = (await readLiveGenerations(stateRoot)).map(
    generationStatus
  );
  const current = generations.find(
    (generation) => generation.state === "current" && generation.alive
  );
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
  return {
    // Its start is recorded once it loaded; before then its pid alone says.
    alive:
      record.pid > 0 && !isGone({ pid: record.pid, started: record.started }),
    number: record.number,
    pid: record.pid,
    state: record.state,
  };
}

function readWorkspaceStatus(
  current: GenerationStatus | undefined,
  record: WorkspaceRecord,
  sessions: number,
  runs: readonly StoredRun[],
  ticks: readonly StoredTick[],
  recovery: RecoveryReport | null
): WorkspaceStatus {
  const host = record.hosted ? current : undefined;
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
