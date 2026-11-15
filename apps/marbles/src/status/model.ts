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
import { readStoredTicks } from "~/database/triggers";
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
interface GenerationStatus {
  readonly alive: boolean;
  readonly number: number;
  readonly pid: number;
  readonly state: GenerationState;
}

export interface WorkspaceStatus {
  /** It is registered, and the current generation's process is alive. */
  readonly alive: boolean;
  /** How many artifacts it shows: its own and those shared with it. */
  readonly artifacts: number;
  readonly config: string | null;
  /** What hosts the workspace: the current engine generation, while it runs. */
  readonly host: "generation" | null;
  /** Registered with the Marbles process, which hosts it in its current generation. */
  readonly hosted: boolean;
  readonly id: string;
  readonly lastSeen: string | null;
  /** Each observer of its changes, by source, then name. */
  readonly observers: readonly ObserverStatus[];
  readonly pid: number | null;
  /** What its last engine start put right after a crash; `null` when none is kept. */
  readonly recovery: RecoveryReport | null;
  readonly root: string;
  /** Its own runs and those shared with it. */
  readonly runs: RunsStatus;
  readonly schedules: readonly ScheduleStatus[];
  /** Its own sessions and those shared with it. */
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

/** An observer's place in its workspace's change log, and how it is faring. */
interface ObserverStatus extends ObserverState {
  /** How many positions of the log it has yet to pass: 0 when it is caught up. */
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
  /** The workspace that owns it, when it is shared with this one. */
  readonly sharedFrom?: string;
  readonly status: string;
  /** The workflow it runs. */
  readonly step: string;
  /** Its top-level steps, in order, each with the status it reached. */
  readonly steps: readonly { readonly name: string; readonly status: string }[];
}

/** What a workspace shows of its resources, read through its view. */
interface Shows {
  readonly artifacts: number;
  readonly runs: readonly Shown<RunResource>[];
  readonly sessions: number;
}

const NOTHING_SHOWN: Shows = { artifacts: 0, runs: [], sessions: 0 };

const RECENT = 5;

/**
 * The state root as stored: the process claim, the live generations, and
 * each workspace the registry records with what it shows of its resources
 * (`ResourceView`). Reads only; a state root without a database stays
 * without one.
 */
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
