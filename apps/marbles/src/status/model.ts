import { isGone } from "@foundry/lib/process-identity";
import { readStoredObservers } from "~/database/changes";
import {
  type GenerationRecord,
  type GenerationState,
  readLiveGenerations,
} from "~/database/generations";
import { readDatabase } from "~/database/open";
import { readLastRecovery } from "~/database/recoveries";
import type { RunResource, Shown } from "~/database/resources";
import { ResourceView } from "~/database/resources";
import type { StoredTick } from "~/database/triggers";
import { isMonitorTick, readStoredTicks } from "~/database/triggers";
import { recordedWorkspaces } from "~/database/workspaces";
import { stateDatabase } from "~/layout";
import type { RecoveryReport } from "~/lib/crash-recovery";
import type { ObserverState } from "~/lib/events/log";
import { TERMINAL_RUN_STATUSES } from "~/lib/run-store";
import { runSteps } from "~/lib/run-trace";
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
  readonly state: GenerationState;
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
  /** Pid of the live tick holding the lock, if any. */
  readonly running: number | null;
}

interface ObserverStatus extends ObserverState {
  readonly behind: number;
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
  readonly sharedFrom?: string;
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
              database,
              scope: { workspace: record.id },
              state: stateRoot,
            });
            read.set(record.id, {
              artifacts: (await view.artifacts()).length,
              runs: await view.runs(),
              sessions: (await view.sessions()).length,
            });
          }
          return read;
        });
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
          shows?.get(record.id) ?? NOTHING_SHOWN,
          await readStoredTicks(stateRoot, record.id),
          await readLastRecovery(stateRoot, record.id),
          await readStoredObservers(stateRoot, record.id)
        )
      )
    ),
  };
}

function generationStatus(record: GenerationRecord): GenerationStatus {
  return {
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
  shows: Shows,
  ticks: readonly StoredTick[],
  recovery: RecoveryReport | null,
  log: Awaited<ReturnType<typeof readStoredObservers>>
): WorkspaceStatus {
  const host = record.hosted ? current : undefined;
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
    runs: runsStatus(record.id, shows.runs),
    schedules: ticks.map(scheduleStatus),
    sessions: shows.sessions,
  };
}

function scheduleStatus(tick: StoredTick): ScheduleStatus {
  const { key, last, running } = tick;
  return {
    key,
    kind: isMonitorTick(tick) ? "monitor" : null,
    lastFinish: last?.lastFinish ?? null,
    lastStatus: last?.lastStatus ?? null,
    name: last?.label ?? key,
    nextDue: last?.nextDue ?? null,
    running,
  };
}

function runsStatus(
  workspace: string,
  shown: readonly Shown<RunResource>[]
): RunsStatus {
  const runs = shown.map(
    ({ ref, value: { owner, record } }): RunSummary => ({
      createdAt: record.timestamps.createdAt,
      id: record.id,
      orphaned:
        !TERMINAL_RUN_STATUSES.has(record.status) &&
        (owner === null || isGone(owner)),
      ...(ref.owner === workspace ? {} : { sharedFrom: ref.owner }),
      status: record.status,
      step: record.step,
      steps: runSteps(record).map(({ name, status }) => ({ name, status })),
    })
  );
  return { recent: runs.slice(0, RECENT), total: runs.length };
}
