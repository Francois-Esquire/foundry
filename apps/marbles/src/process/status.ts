import {
  isGone,
  type ProcessState,
  processState,
} from "@foundry/lib/node/process-identity";
import type { GenerationRecord, GenerationState } from "~/database/generations";
import {
  readDatabase,
  readLastRecovery,
  readLiveGenerations,
  readStoredObservers,
  readStoredSchedules,
  recordedWorkspaces,
} from "~/database/open";
import type { RunResource, Shown } from "~/database/resources";
import { ResourceView } from "~/database/resources";
import type { ScheduleSnapshot } from "~/database/triggers";
import { stateDatabase } from "~/layout";
import type { RecoveryReport } from "~/lib/crash-recovery";
import type { ObserverState } from "~/lib/events/log";
import { TERMINAL_RUN_STATUSES } from "~/lib/run-store";
import { runSteps } from "~/lib/run-trace";
import type { WorkspaceRecord } from "~/lib/state/workspace";
import { insideState } from "~/lib/state/workspace";
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
  readonly artifacts: number;
  readonly config: string | null;
  readonly host: "generation" | null;
  readonly hosted: boolean;
  readonly id: string;
  readonly lastSeen: string | null;
  readonly observers: readonly ObserverStatus[];
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
  readonly running: number | null;
}

interface ObserverStatus extends ObserverState {
  readonly behind: number;
}

interface RunsStatus {
  readonly recent: readonly RunSummary[];
  readonly total: number;
}

interface RunSummary {
  readonly createdAt: number;
  readonly id: string;
  readonly orphaned: boolean;
  readonly status: string;
  readonly step: string;
  readonly steps: readonly { readonly name: string; readonly status: string }[];
}

interface Shows {
  readonly artifacts: number;
  readonly runs: readonly Shown<RunResource>[];
  readonly sessions: number;
}

const NOTHING_SHOWN: Shows = { artifacts: 0, runs: [], sessions: 0 };

const RECENT = 5;

export async function readStatus(stateRoot: string): Promise<StatusReport> {
  const records = await recordedWorkspaces(stateRoot);
  const shows =
    records.length === 0
      ? undefined
      : await readDatabase(stateDatabase(stateRoot), async (database) => {
          const read = new Map<string, Shows>();
          for (const record of records) {
            const view = new ResourceView({
              acceptWorkspace: (workspaceId) =>
                insideState(stateRoot, workspaceId),
              database,
              scope: { workspace: record.id },
            });
            read.set(record.id, {
              artifacts: (await view.artifacts()).length,
              runs: await view.runs(),
              sessions: (await view.sessions()).length,
            });
          }
          return read;
        });
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
          shows?.get(record.id) ?? NOTHING_SHOWN,
          await readStoredSchedules(stateRoot, record.id),
          await readLastRecovery(stateRoot, record.id),
          await readStoredObservers(stateRoot, record.id)
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
  shows: Shows,
  schedules: readonly ScheduleSnapshot[],
  recovery: RecoveryReport | null,
  log: Awaited<ReturnType<typeof readStoredObservers>>
): WorkspaceStatus {
  const host =
    record.hosted && current?.workspaces.includes(record.id) === true
      ? current
      : undefined;
  return {
    alive: host !== undefined,
    artifacts: shows.artifacts,
    config: record.config,
    host: host === undefined ? null : "generation",
    hosted: record.hosted,
    id: record.id,
    lastSeen: record.lastSeen,
    observers: log.observers.map((observer) => ({
      ...observer,
      behind: Math.max(0, log.head - observer.position),
    })),
    pid: host?.pid ?? null,
    recovery,
    root: record.root,
    runs: runsStatus(shows.runs),
    schedules: schedules.map(scheduleStatus),
    sessions: shows.sessions,
  };
}

function scheduleStatus(stored: ScheduleSnapshot): ScheduleStatus {
  return {
    key: stored.key,
    kind: stored.kind === "monitor" ? "monitor" : null,
    lastFinish: stored.lastSettledAt ?? null,
    lastStatus: stored.lastStatus ?? null,
    name: stored.label,
    nextDue: stored.nextDue ?? null,
    running: stored.running,
  };
}

function runsStatus(shown: readonly Shown<RunResource>[]): RunsStatus {
  const runs = shown.map(
    ({ value: { owner, record } }): RunSummary => ({
      createdAt: record.timestamps.createdAt,
      id: record.id,
      orphaned:
        !TERMINAL_RUN_STATUSES.has(record.status) &&
        (owner === null || isGone(owner)),
      status: record.status,
      step: record.step,
      steps: runSteps(record).map(({ name, status }) => ({ name, status })),
    })
  );
  return { recent: runs.slice(0, RECENT), total: runs.length };
}
