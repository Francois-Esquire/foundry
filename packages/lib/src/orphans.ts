/**
 * Stopping what a process that is gone left running: the children it
 * started, as the recovery records in one directory name them
 * (`MARBLES_SPAWN_RECOVERY`, `@foundry/lib/spawn-record`).
 *
 * A record is an orphan's when the process it names still runs, started
 * when the record says, and its owner does not: no process has the
 * owner's pid, or one that started at another time does. Only an orphan
 * is signalled, and only once it is proved again right before each
 * signal. Nothing else is:
 *
 * - this process, whatever its record says;
 * - a record without an owner, or that cannot be read;
 * - a process whose start time differs from its record (the pid is
 *   someone else's now): its record is removed, and it is left alone;
 * - one recorded leading a group of its own that no longer does.
 *
 * An orphan gets SIGTERM (its group, when it leads one), a grace period,
 * SIGKILL, and a last wait. The record of a process confirmed gone is
 * removed; one that would not stop keeps its record and is reported.
 * Stopping an orphan can leave orphans of its own, its recorded
 * children, so the directory is read again until a pass stops nothing.
 *
 * Safe to run at any time and more than once, from any process: a
 * process whose owner is alive is never touched, and a stop cut short
 * leaves records that the next run reads again.
 *
 * Node-bound: import it from main-process code only.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  notPrivate,
  type ProcessIdentity,
  recordPath,
  type SpawnRecord,
  sameStart,
} from "./spawn-record";

/** What a stop did: the pids it stopped, and what it could not do. */
export interface OrphanStop {
  readonly problems: readonly string[];
  readonly stopped: readonly number[];
}

export interface OrphanStopOptions {
  /** How long an orphan gets to exit after SIGTERM. */
  readonly graceMs?: number;
  /** How long after SIGKILL before a survivor is reported. */
  readonly killMs?: number;
  /** How the stop reaches the system; a test replaces it. */
  readonly system?: ProcessTable;
}

/** What the system says about a running process. */
export interface SeenProcess {
  readonly pgid: number;
  readonly started: string;
}

/** The system calls a stop makes. */
export interface ProcessTable {
  kill(target: number, signal: NodeJS.Signals): void;
  /**
   * What the system says about each of `pids` that is running; `undefined`
   * when it cannot say.
   */
  look(pids: readonly number[]): ReadonlyMap<number, SeenProcess> | undefined;
  sleep(ms: number): Promise<void>;
}

const GRACE_MS = 5000;
const KILL_MS = 2000;
const POLL_MS = 100;
/** Each pass follows the orphans of the last one down a generation. */
const MAX_PASSES = 8;
const PS_TIMEOUT_MS = 5000;
const PS_ENV = { ...process.env, LC_ALL: "C", TZ: "UTC" };
const LOOK_LINE = /^\s*(\d+)\s+(\d+)\s+(.+)$/;

/** Stop every orphan the recovery records in `dir` name (see above). */
export async function stopOrphans(
  dir: string,
  options: OrphanStopOptions = {}
): Promise<OrphanStop> {
  const system = options.system ?? SYSTEM;
  const limits = {
    graceMs: options.graceMs ?? GRACE_MS,
    killMs: options.killMs ?? KILL_MS,
  };
  const stopped: number[] = [];
  const problems = new Set<string>();
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const found = orphansIn(dir, system);
    for (const problem of found.problems) {
      problems.add(problem);
    }
    if (found.orphans.length === 0) {
      break;
    }
    const result = await stopAll(dir, found.orphans, system, limits);
    stopped.push(...result.stopped);
    for (const problem of result.problems) {
      problems.add(problem);
    }
    if (result.stopped.length === 0) {
      break;
    }
  }
  return { problems: [...problems], stopped };
}

interface Found {
  readonly orphans: readonly SpawnRecord[];
  readonly problems: readonly string[];
}

/** The orphans `dir` records now; the records of processes that are gone go. */
function orphansIn(dir: string, system: ProcessTable): Found {
  const { problems, records } = readRecords(dir);
  const pids = records.flatMap((record) =>
    record.owner === undefined ? [record.pid] : [record.pid, record.owner.pid]
  );
  const seen = system.look([...new Set(pids)]);
  if (seen === undefined) {
    return {
      orphans: [],
      problems: [...problems, "ps could not list the recorded processes"],
    };
  }
  const orphans: SpawnRecord[] = [];
  for (const record of records) {
    const verdict = judge(record, seen);
    if (verdict === "gone") {
      forget(dir, record.pid);
    } else if (verdict === "orphan") {
      orphans.push(record);
    } else if (typeof verdict === "object") {
      problems.push(verdict.problem);
    }
  }
  return { orphans, problems };
}

type Verdict = "gone" | "kept" | "orphan" | { readonly problem: string };

function judge(
  record: SpawnRecord,
  seen: ReadonlyMap<number, SeenProcess>
): Verdict {
  if (record.pid === process.pid) {
    return "kept";
  }
  if (!running(record, seen)) {
    return "gone";
  }
  if (record.owner === undefined || running(record.owner, seen)) {
    return "kept";
  }
  if (record.group && seen.get(record.pid)?.pgid !== record.pid) {
    return {
      problem: `process ${String(record.pid)} was recorded leading its own group and no longer does; not signalled`,
    };
  }
  return "orphan";
}

/** The process `identity` names runs now: one has its pid and started then. */
function running(
  identity: ProcessIdentity,
  seen: ReadonlyMap<number, SeenProcess>
): boolean {
  const found = seen.get(identity.pid);
  return found !== undefined && sameStart(found.started, identity.started);
}

/** SIGTERM, a grace period, SIGKILL, a last wait; each signal on a fresh proof. */
async function stopAll(
  dir: string,
  orphans: readonly SpawnRecord[],
  system: ProcessTable,
  limits: { readonly graceMs: number; readonly killMs: number }
): Promise<OrphanStop> {
  signal(orphans, "SIGTERM", system);
  let left = await waitGone(orphans, limits.graceMs, system);
  if (left.length > 0) {
    signal(left, "SIGKILL", system);
    left = await waitGone(left, limits.killMs, system);
  }
  const survivors = new Set(left.map(({ pid }) => pid));
  const stopped = orphans
    .filter(({ pid }) => !survivors.has(pid))
    .map(({ pid }) => pid);
  for (const pid of stopped) {
    forget(dir, pid);
  }
  return {
    problems: left.map(
      ({ pid }) => `process ${String(pid)} would not stop; its record is kept`
    ),
    stopped,
  };
}

/** Signal each of `records` still running as recorded, its group when it leads one. */
function signal(
  records: readonly SpawnRecord[],
  name: NodeJS.Signals,
  system: ProcessTable
): void {
  for (const record of records) {
    // Proved right before its own signal: what an earlier one changed shows.
    const seen = system.look([record.pid]);
    if (seen === undefined || !running(record, seen)) {
      continue;
    }
    try {
      system.kill(record.group ? -record.pid : record.pid, name);
    } catch (error) {
      // Gone between the proof and the signal; a group of exited members
      // not yet reaped answers EPERM on macOS.
      const { code } = error as NodeJS.ErrnoException;
      if (code !== "ESRCH" && code !== "EPERM") {
        throw error;
      }
    }
  }
}

/** Poll until none of `records` runs as recorded, or `ms` pass; those still running. */
async function waitGone(
  records: readonly SpawnRecord[],
  ms: number,
  system: ProcessTable
): Promise<SpawnRecord[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const seen = system.look(records.map(({ pid }) => pid));
    // A table that cannot say proves nothing gone.
    const left =
      seen === undefined
        ? [...records]
        : records.filter((record) => running(record, seen));
    if (left.length === 0 || Date.now() >= deadline) {
      return left;
    }
    await system.sleep(POLL_MS);
  }
}

interface Records {
  readonly problems: string[];
  readonly records: readonly SpawnRecord[];
}

/**
 * The records directly in `dir`, each file checked private first; one
 * that is not, or cannot be read, is a problem, and names nothing to stop.
 * Files in flight (`.tmp`) are not records yet.
 */
function readRecords(dir: string): Records {
  const problems: string[] = [];
  const records: SpawnRecord[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    return gone(error)
      ? { problems, records }
      : {
          problems: [`cannot list the records in ${dir}: ${String(error)}`],
          records,
        };
  }
  const unsafe = notPrivate(dir, "directory");
  if (unsafe !== undefined) {
    return { problems: [`skipped ${unsafe}`], records };
  }
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const path = join(dir, name);
    const problem = notPrivate(path, "file");
    if (problem !== undefined) {
      // One removed meanwhile, by another stop, is no problem.
      if (existsSync(path)) {
        problems.push(`skipped ${problem}`);
      }
      continue;
    }
    try {
      const record: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isRecord(record)) {
        records.push(record);
      } else {
        problems.push(`${path} is not a process record`);
      }
    } catch (error) {
      if (!gone(error)) {
        problems.push(
          `cannot read the process record ${path}: ${String(error)}`
        );
      }
    }
  }
  return { problems, records };
}

function isRecord(value: unknown): value is SpawnRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { group, owner } = value as Partial<SpawnRecord>;
  return (
    typeof group === "boolean" &&
    (owner === undefined || isIdentity(owner)) &&
    isIdentity(value)
  );
}

function isIdentity(value: unknown): value is ProcessIdentity {
  const identity = value as Partial<ProcessIdentity> | null;
  return (
    typeof identity === "object" &&
    identity !== null &&
    Number.isInteger(identity.pid) &&
    (identity.pid ?? 0) > 0 &&
    typeof identity.started === "string"
  );
}

function forget(dir: string, pid: number): void {
  rmSync(recordPath(dir, pid), { force: true });
}

function gone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

const SYSTEM: ProcessTable = {
  kill: (target, name) => process.kill(target, name),
  look(pids) {
    const seen = new Map<number, SeenProcess>();
    if (pids.length === 0) {
      return seen;
    }
    const listed = spawnSync(
      "ps",
      ["-o", "pid=,pgid=,lstart=", "-p", pids.join(",")],
      { encoding: "utf8", env: PS_ENV, timeout: PS_TIMEOUT_MS }
    );
    // `ps` exits 1 when one of the pids has no process, and lists the rest.
    if (listed.error !== undefined || (listed.status ?? 2) > 1) {
      return;
    }
    for (const line of listed.stdout.split("\n")) {
      const parsed = LOOK_LINE.exec(line);
      if (parsed) {
        seen.set(Number(parsed[1]), {
          pgid: Number(parsed[2]),
          started: parsed[3] ?? "",
        });
      }
    }
    return seen;
  },
  sleep: (ms) => sleep(ms),
};
