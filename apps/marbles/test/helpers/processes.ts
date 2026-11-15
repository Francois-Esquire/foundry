import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  recordSpawned,
  SPAWN_RECORD_ENV,
  type SpawnRecord,
} from "~/process/spawned";

/**
 * The processes a test run may stop are the ones it recorded as it
 * started them (`recordSpawned`, here and in Marbles itself): pid, start
 * time, and whether each leads a process group of its own. Before every
 * signal each one is proved again, from what the system says right then:
 *
 * - no process has the pid, or one that started at another time does:
 *   it is gone, and the pid is someone else's now;
 * - one that started then does, and leads its group if the record says
 *   so, and carries the run's marker in its environment where that can be
 *   read (macOS shows no one the environment of its own platform
 *   binaries): it is the one recorded, and gets the signal, with its
 *   group when it leads one;
 * - anything else is a problem, reported and never signalled.
 *
 * A group whose recorded leader has exited may still hold processes; each
 * is stopped only on a record of its own, and otherwise reported.
 * An environment marker alone never selects a process: it is read from
 * the environment only, never the command line, and finds what was not
 * recorded so that it can be reported.
 */

export interface Marker {
  readonly name: string;
  readonly value: string;
}

export interface StopLimits {
  /** How long the processes get to exit after SIGTERM. */
  readonly graceMs: number;
  /** How long after SIGKILL before a survivor is reported. */
  readonly killMs: number;
}

/** What the system says about a process right now. */
interface Seen {
  readonly pgid: number;
  readonly started: string;
}

/** How a stop reaches the system; a test replaces it to model pid reuse. */
export interface ProcessSystem {
  /**
   * The environment of `pid`, one `NAME=value` per entry; empty when it
   * cannot be read, `undefined` when no process has the pid.
   */
  environment(pid: number): readonly string[] | undefined;
  kill(target: number, signal: NodeJS.Signals): void;
  /** What the system says about each of `pids` that is running. */
  look(pids: readonly number[]): ReadonlyMap<number, Seen>;
  /** The processes in the group `pgid`. */
  members(pgid: number): readonly number[];
  sleep(ms: number): Promise<void>;
}

const LIMITS: StopLimits = { graceMs: 5000, killMs: 2000 };
const POLL_MS = 100;
const PS_ENV = { ...process.env, LC_ALL: "C", TZ: "UTC" };
const LOOK_LINE = /^\s*(\d+)\s+(\d+)\s+(.+)$/;
const PID_PAIR = /^\s*(\d+)\s+(\d+)\s*$/;
const COMMAND_LINE = /^\s*(\d+) (.*)$/;
const PID = /^\d+$/;
const SPACES = /\s+/g;

/** Record `pid`, which the caller has just started, in `dir`; see `recordSpawned`. */
export function recordProcess(dir: string, pid: number, group: boolean): void {
  recordSpawned(pid, group, { [SPAWN_RECORD_ENV]: dir });
}

/**
 * Stop every process recorded under `dir`, proving each one before every
 * signal: SIGTERM, a grace period, SIGKILL, a last wait. Resolves with
 * what went wrong, empty when every recorded process is confirmed gone;
 * the records of those go with them.
 */
export async function stopRecorded(
  dir: string,
  marker: Marker,
  limits: StopLimits = LIMITS,
  system: ProcessSystem = SYSTEM
): Promise<string[]> {
  const stop = new RecordedStop(readRecords(dir), marker, system);
  stop.round("SIGTERM");
  await stop.waitGone(limits.graceMs);
  stop.round("SIGKILL");
  const report = stop.report(await stop.waitGone(limits.killMs));
  if (report.length === 0) {
    rmSync(dir, { force: true, recursive: true });
  }
  return report;
}

/** One stop of a set of records: what has been proved, and what went wrong. */
class RecordedStop {
  readonly #records: readonly SpawnRecord[];
  readonly #recorded: ReadonlySet<number>;
  readonly #marker: Marker;
  readonly #system: ProcessSystem;
  readonly #problems = new Map<number, string>();
  /** Groups whose leader was proved in this stop, which may outlive it. */
  readonly #groups = new Set<number>();

  constructor(
    records: readonly SpawnRecord[],
    marker: Marker,
    system: ProcessSystem
  ) {
    this.#records = records;
    this.#recorded = new Set(records.map(({ pid }) => pid));
    this.#marker = marker;
    this.#system = system;
  }

  /** Prove every record now, signal the proved ones; the pids still there. */
  round(signal: NodeJS.Signals | undefined): number[] {
    const seen = this.#system.look(this.#records.map(({ pid }) => pid));
    const left: number[] = [];
    for (const record of this.#records) {
      if (this.#problems.has(record.pid)) {
        continue;
      }
      const proof = prove(
        record,
        seen.get(record.pid),
        this.#marker,
        this.#system
      );
      if (typeof proof === "object") {
        this.#problems.set(record.pid, proof.problem);
      } else if (proof === "recorded") {
        this.#signal(record, signal);
        left.push(record.pid);
      }
    }
    return left;
  }

  /** Poll, proving again each time, until nothing is left or `ms` pass. */
  async waitGone(ms: number): Promise<number[]> {
    const deadline = Date.now() + ms;
    let left = this.round(undefined);
    while (
      (left.length > 0 || this.#remnants().length > 0) &&
      Date.now() < deadline
    ) {
      await this.#system.sleep(POLL_MS);
      left = this.round(undefined);
    }
    return left;
  }

  report(survivors: readonly number[]): string[] {
    return [
      ...this.#problems.values(),
      ...survivors.map((pid) => `process ${String(pid)} would not stop`),
      ...this.#remnants().map(
        (pid) =>
          `process ${String(pid)} outlived the recorded leader of its group and has no record of its own; not signalled`
      ),
    ];
  }

  #signal(record: SpawnRecord, signal: NodeJS.Signals | undefined): void {
    if (record.group) {
      this.#groups.add(record.pid);
    }
    if (signal !== undefined) {
      signalIfThere(
        this.#system,
        record.group ? -record.pid : record.pid,
        signal
      );
    }
  }

  /** What is still in a proved group without a record of its own. */
  #remnants(): number[] {
    return [...this.#groups].flatMap((pgid) =>
      this.#system.members(pgid).filter((pid) => !this.#recorded.has(pid))
    );
  }
}

/**
 * The other processes whose environment, not their command line, holds
 * `marker` and that no record under `dir` names: what a test or a run
 * started without recording it. Not stopped, since nothing proves them
 * the run's; a caller reports them.
 */
export function unrecordedMarked(dir: string, marker: Marker): number[] {
  const recorded = new Set(readRecords(dir).map(({ pid }) => pid));
  const entry = `${marker.name}=${marker.value}`;
  return [...environments()]
    .filter(
      ([pid, environment]) =>
        pid !== process.pid && !recorded.has(pid) && environment.includes(entry)
    )
    .map(([pid]) => pid);
}

type Proof = "gone" | "recorded" | { readonly problem: string };

function prove(
  record: SpawnRecord,
  seen: Seen | undefined,
  marker: Marker,
  system: ProcessSystem
): Proof {
  if (seen === undefined || seen.started !== normal(record.started)) {
    return "gone";
  }
  const pid = String(record.pid);
  if (record.group && seen.pgid !== record.pid) {
    return {
      problem: `process ${pid} was recorded leading its own group and is now in group ${String(seen.pgid)}; not signalled`,
    };
  }
  const environment = system.environment(record.pid);
  if (environment === undefined) {
    return "gone";
  }
  const entry = `${marker.name}=${marker.value}`;
  if (environment.length > 0 && !environment.includes(entry)) {
    return {
      problem: `process ${pid} matches its record but its environment lacks ${entry}; not signalled`,
    };
  }
  return "recorded";
}

function signalIfThere(
  system: ProcessSystem,
  target: number,
  signal: NodeJS.Signals
): void {
  try {
    system.kill(target, signal);
  } catch (error) {
    // Gone between the proof and the signal; a group of exited members
    // not yet reaped answers EPERM on macOS.
    const { code } = error as NodeJS.ErrnoException;
    if (code !== "ESRCH" && code !== "EPERM") {
      throw error;
    }
  }
}

function readRecords(dir: string): SpawnRecord[] {
  if (!existsSync(dir)) {
    return [];
  }
  const records: SpawnRecord[] = [];
  for (const entry of readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!(entry.isFile() && entry.name.endsWith(".json"))) {
      continue;
    }
    const path = join(entry.parentPath, entry.name);
    const record = JSON.parse(readFileSync(path, "utf8")) as SpawnRecord;
    if (
      !(
        Number.isInteger(record.pid) &&
        typeof record.group === "boolean" &&
        typeof record.started === "string"
      )
    ) {
      throw new Error(`not a process record: ${path}`);
    }
    records.push(record);
  }
  return records;
}

function normal(started: string): string {
  return started.trim().replace(SPACES, " ");
}

const SYSTEM: ProcessSystem = {
  environment(pid) {
    return process.platform === "linux"
      ? linuxEnvironment(pid)
      : environments([pid]).get(pid);
  },
  kill: (target, signal) => process.kill(target, signal),
  look(pids) {
    const seen = new Map<number, Seen>();
    if (pids.length === 0) {
      return seen;
    }
    const listed = ps(["-o", "pid=,pgid=,lstart=", "-p", pids.join(",")]);
    for (const line of listed.split("\n")) {
      const parsed = LOOK_LINE.exec(line);
      if (parsed) {
        seen.set(Number(parsed[1]), {
          pgid: Number(parsed[2]),
          started: normal(parsed[3] ?? ""),
        });
      }
    }
    return seen;
  },
  members(pgid) {
    return ps(["-A", "-o", "pid=,pgid="])
      .split("\n")
      .map((line) => PID_PAIR.exec(line))
      .filter((parsed) => parsed !== null && Number(parsed[2]) === pgid)
      .map((parsed) => Number(parsed?.[1]));
  },
  sleep: (ms) => sleep(ms),
};

/** `ps` with its output; it exits 1 when a pid it was given is not running. */
function ps(args: readonly string[]): string {
  const listed = spawnSync("ps", args, {
    encoding: "utf8",
    env: PS_ENV,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (listed.error !== undefined || (listed.status ?? 2) > 1) {
    throw new Error(
      `ps ${args.join(" ")} failed: ${listed.stderr ?? String(listed.error)}`
    );
  }
  return listed.stdout;
}

/**
 * Each listed process's environment. macOS prints it after the command
 * line under `-E`, so it is what follows the command line printed without
 * `-E`: an argument cannot land there. Empty for a process whose
 * environment the system will not show.
 */
function environments(
  pids?: readonly number[]
): Map<number, readonly string[]> {
  if (process.platform === "linux") {
    const all =
      pids ??
      readdirSync("/proc")
        .filter((entry) => PID.test(entry))
        .map(Number);
    return new Map(
      all.flatMap((pid) => {
        const environment = linuxEnvironment(pid);
        return environment === undefined ? [] : [[pid, environment] as const];
      })
    );
  }
  const which = pids === undefined ? ["-A"] : ["-p", pids.join(",")];
  const commands = byPid(ps(["-ww", "-o", "pid=,command=", ...which]));
  const withEnvironment = byPid(ps(["-wwE", "-o", "pid=,command=", ...which]));
  const found = new Map<number, readonly string[]>();
  for (const [pid, command] of commands) {
    const full = withEnvironment.get(pid);
    if (full === undefined) {
      continue;
    }
    const rest = full.startsWith(command) ? full.slice(command.length) : "";
    found.set(
      pid,
      rest.split(" ").filter((word) => word !== "")
    );
  }
  return found;
}

function byPid(listed: string): Map<number, string> {
  const lines = new Map<number, string>();
  for (const line of listed.split("\n")) {
    const parsed = COMMAND_LINE.exec(line);
    if (parsed) {
      lines.set(Number(parsed[1]), parsed[2] ?? "");
    }
  }
  return lines;
}

/** Linux: the process's initial environment, NUL-separated. */
function linuxEnvironment(pid: number): readonly string[] | undefined {
  try {
    return readFileSync(`/proc/${String(pid)}/environ`, "utf8")
      .split("\0")
      .filter((entry) => entry !== "");
  } catch (error) {
    // Not ours to read counts as unreadable; gone counts as gone.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : [];
  }
}
