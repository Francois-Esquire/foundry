import { join } from "node:path";

import { processAlive } from "@foundry/lib/file-lock";
import { readDatabase } from "~/database/open";
import type { RunResource, Shown } from "~/database/resources";
import { ResourceView } from "~/database/resources";
import type { StoredTick } from "~/database/triggers";
import { readStoredTicks } from "~/database/triggers";
import { recordedWorkspaces } from "~/database/workspaces";
import { stateDatabase } from "~/layout";
import { TERMINAL_RUN_STATUSES } from "~/lib/run-store";
import { runSteps } from "~/lib/run-trace";
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
  /** How many artifacts it shows: its own and those shared with it. */
  readonly artifacts: number;
  readonly config: string | null;
  /** What holds the workspace: its worker, or the daemon itself. */
  readonly host: ProcessHost | null;
  /** The Marbles process starts a worker for it. */
  readonly hosted: boolean;
  readonly id: string;
  readonly lastSeen: string | null;
  readonly pid: number | null;
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

const RECENT = 5;

/**
 * The state root as stored: the process claim, and each workspace the
 * registry records with what its directory holds and what it shows of its
 * resources (`ResourceView`). Reads only; a state root without a database
 * stays without one.
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
  return {
    process: readProcess(stateRoot) ?? null,
    root: stateRoot,
    workspaces: await Promise.all(
      records.map(async (record) =>
        readWorkspaceStatus(
          join(stateRoot, record.id),
          record,
          shows?.get(record.id) ?? NOTHING_SHOWN,
          await readStoredTicks(stateRoot, record.id)
        )
      )
    ),
  };
}

const NOTHING_SHOWN: Shows = { artifacts: 0, runs: [], sessions: 0 };

function readWorkspaceStatus(
  dir: string,
  record: WorkspaceRecord,
  shows: Shows,
  ticks: readonly StoredTick[]
): WorkspaceStatus {
  const owner = readProcess(dir);
  return {
    alive: owner?.alive ?? false,
    artifacts: shows.artifacts,
    config: record.config,
    host: owner?.alive ? owner.host : null,
    hosted: record.hosted,
    id: record.id,
    lastSeen: record.lastSeen,
    pid: owner?.pid ?? null,
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
    ({ ref, value: { ownerPid, record } }): RunSummary => ({
      createdAt: record.timestamps.createdAt,
      id: record.id,
      orphaned:
        !TERMINAL_RUN_STATUSES.has(record.status) &&
        (ownerPid === null || !processAlive(ownerPid)),
      ...(ref.owner === workspace ? {} : { sharedFrom: ref.owner }),
      status: record.status,
      step: record.step,
      steps: runSteps(record).map(({ name, status }) => ({ name, status })),
    })
  );
  return { recent: runs.slice(0, RECENT), total: runs.length };
}
