import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  type Dirent,
  existsSync,
  linkSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  notPrivate,
  recordSpawned,
  SPAWN_RECORD_ENV,
  type SpawnRecord,
} from "~/process/spawned";

/**
 * The processes a test run may stop are the ones it recorded as it
 * started them (`recordSpawned`, here and in Marbles itself): pid, start
 * time, and whether each leads a process group of its own. A record is
 * read only from a private file in private directories (`notPrivate`);
 * any other is skipped and reported. Before each process's own signal,
 * it is proved again, from what the system says about it right then:
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
/** Each pass stops what the processes of the last one recorded meanwhile. */
const MAX_PASSES = 8;
/** A partial record this old is a dead writer's: a write takes a moment. */
const STALE_PARTIAL_MS = 60_000;
/** How long `ps` gets to answer, so a stop takes a bounded time. */
const PS_TIMEOUT_MS = 5000;
const PS_ENV = { ...process.env, LC_ALL: "C", TZ: "UTC" };
const LOOK_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/;
const MEMBER_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/;
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
 * what went wrong, empty when every recorded process is confirmed gone.
 * A process still running may record another meanwhile, so the records
 * are read again after each stop, and a new one is stopped in turn; the
 * record of each process confirmed gone is removed, and `dir` goes only
 * once that leaves it empty, so a record written after the last read
 * keeps it, and is stopped by the next pass or the next sweep.
 */
export async function stopRecorded(
  dir: string,
  marker: Marker,
  limits: StopLimits = LIMITS,
  system: ProcessSystem = SYSTEM
): Promise<string[]> {
  const problems = new Set<string>();
  /** The records already stopped, by path and start: a reused pid's is new. */
  const handled = new Set<string>();
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const read = readRecords(dir);
    for (const problem of read.problems) {
      problems.add(problem);
    }
    const fresh = read.records.filter(
      (record) => !handled.has(handledKey(record))
    );
    if (fresh.length === 0) {
      if (problems.size > 0 || removeEmpty(dir) === 0) {
        return [...problems];
      }
      // A record arrived after the read: stop it next pass.
      await system.sleep(POLL_MS);
      continue;
    }
    const stop = new RecordedStop(
      { problems: [], records: fresh },
      marker,
      system
    );
    stop.round("SIGTERM");
    await stop.waitGone(limits.graceMs);
    stop.round("SIGKILL");
    const report = stop.report(await stop.waitGone(limits.killMs));
    for (const record of fresh) {
      handled.add(handledKey(record));
    }
    for (const problem of report) {
      problems.add(problem);
    }
    if (report.length === 0) {
      for (const record of fresh) {
        forgetRecord(record);
      }
    }
  }
  problems.add(
    `${dir} still held files that are not records of stopped processes after ${String(MAX_PASSES)} passes; kept`
  );
  return [...problems];
}

function handledKey(record: ReadRecord): string {
  return `${record.path}\n${record.started}`;
}

/** The file operations `forgetRecord` makes; a test replaces them to land a write between two. */
export interface RecordFiles {
  /** Make `path` name `existing`'s file; throws `EEXIST` when `path` is taken. */
  link(existing: string, path: string): void;
  read(path: string): string;
  remove(path: string): void;
  rename(from: string, to: string): void;
}

const FILES: RecordFiles = {
  link: (existing, path) => linkSync(existing, path),
  read: (path) => readFileSync(path, "utf8"),
  remove: (path) => rmSync(path, { force: true }),
  rename: (from, to) => renameSync(from, to),
};

/**
 * Remove the record file at `record.path`, only if what is removed names
 * `record`'s process, which has been proved gone. A process that records
 * another may replace the file at any moment, so nothing read before
 * decides: the file is moved aside first, under a fresh name in the same
 * directory (a rename, atomic), read there, and deleted only if it names
 * that process. One that does not is linked back, never over a file that
 * took its place meanwhile: that one is newer, and this one then stays
 * aside, under a name that is still a record's (`.json`), for the next
 * pass or sweep to read. So no interleaving removes the record of a
 * process that runs, and a stop cut short leaves every record readable.
 */
export function forgetRecord(
  record: Pick<ReadRecord, "path" | "pid" | "started">,
  files: RecordFiles = FILES
): void {
  const aside = join(
    dirname(record.path),
    `.${basename(record.path)}.${randomUUID()}.forget.json`
  );
  try {
    files.rename(record.path, aside);
  } catch (error) {
    if (gone(error)) {
      return;
    }
    throw error;
  }
  let moved: Partial<SpawnRecord> | undefined;
  try {
    moved = JSON.parse(files.read(aside)) as Partial<SpawnRecord>;
  } catch {
    moved = undefined;
  }
  if (moved?.pid === record.pid && moved.started === record.started) {
    files.remove(aside);
    return;
  }
  try {
    files.link(aside, record.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return;
    }
    throw error;
  }
  files.remove(aside);
}

/**
 * Remove `dir` and the directories under it, without removing any file
 * but a stale partial record (`.tmp`), which a writer that died left:
 * how many records, or other files, are left, `0` once there are none.
 * A partial record still being written keeps its directory without
 * counting: a stop it interrupted is what makes one, its record would
 * name a process that was recorded too late to run, and whatever sweep
 * comes next reads it once it is renamed into place, or removes it once
 * it is stale.
 */
function removeEmpty(dir: string): number {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (gone(error)) {
      return 0;
    }
    throw error;
  }
  let left = 0;
  let partial = false;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      left += removeEmpty(path);
      partial ||= existsSync(path);
    } else if (entry.name.endsWith(".tmp")) {
      if (stale(path)) {
        rmSync(path, { force: true });
      } else {
        partial = true;
      }
    } else {
      left += 1;
    }
  }
  if (left > 0 || partial) {
    return left;
  }
  try {
    rmdirSync(dir);
    return 0;
  } catch (error) {
    // Not empty: an entry arrived after it was listed.
    return gone(error) ? 0 : 1;
  }
}

function stale(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > STALE_PARTIAL_MS;
  } catch {
    return true;
  }
}

/** One stop of a set of records: what has been proved, and what went wrong. */
class RecordedStop {
  readonly #records: readonly SpawnRecord[];
  readonly #recorded: ReadonlySet<number>;
  readonly #marker: Marker;
  readonly #system: ProcessSystem;
  readonly #problems = new Map<number, string>();
  readonly #unreadable: readonly string[];
  /** The pids last found matching their records in part, not signalled. */
  #unproven = new Set<number>();
  /**
   * Groups that may hold processes without records: one whose recorded
   * leader was proved in this stop, or whose leader's pid no process
   * holds any more. Its id cannot name another group while any of its
   * processes remain, and a new one would need a leader with that pid.
   */
  readonly #groups = new Set<number>();

  constructor(
    { problems, records }: Records,
    marker: Marker,
    system: ProcessSystem
  ) {
    this.#records = records;
    this.#recorded = new Set(records.map(({ pid }) => pid));
    this.#unreadable = problems;
    this.#marker = marker;
    this.#system = system;
  }

  /** Prove every record now, signal the proved ones; the pids still there. */
  round(signal: NodeJS.Signals | undefined): number[] {
    const left: number[] = [];
    this.#unproven = new Set();
    for (const record of this.#records) {
      if (this.#problems.has(record.pid)) {
        continue;
      }
      const environment = this.#system.environment(record.pid);
      // Read last, right before this one's own signal: what an earlier
      // record's stop took long enough to change shows here.
      const found = this.#system.look([record.pid]).get(record.pid);
      const proof = prove(record, found, environment, this.#marker);
      if (typeof proof === "object") {
        this.#problems.set(record.pid, proof.problem);
      } else if (proof === "recorded") {
        this.#signal(record, signal);
        left.push(record.pid);
      } else if (proof === "unproven") {
        this.#unproven.add(record.pid);
        left.push(record.pid);
      } else if (record.group && found === undefined) {
        this.#groups.add(record.pid);
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
      ...this.#unreadable,
      ...this.#problems.values(),
      ...survivors.map((pid) =>
        this.#unproven.has(pid)
          ? `process ${String(pid)} matches its record, but could not be proved; not signalled`
          : `process ${String(pid)} would not stop`
      ),
      ...this.#remnants().map(
        ([pid, pgid]) =>
          `process ${String(pid)} is in the group of the recorded process ${String(pgid)} and has no record of its own; not signalled`
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

  /** What is in one of those groups without a record of its own: pid and group. */
  #remnants(): [number, number][] {
    return [...this.#groups].flatMap((pgid) =>
      this.#system
        .members(pgid)
        .filter((pid) => !this.#recorded.has(pid))
        .map((pid): [number, number] => [pid, pgid])
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
  const recorded = new Set(readRecords(dir).records.map(({ pid }) => pid));
  const entry = `${marker.name}=${marker.value}`;
  return [...environments()]
    .filter(
      ([pid, environment]) =>
        pid !== process.pid && !recorded.has(pid) && environment.includes(entry)
    )
    .map(([pid]) => pid);
}

/**
 * `unproven`: it matches its record as far as could be read, but the
 * rest could not be read this time; not signalled, and looked at again.
 */
type Proof = "gone" | "recorded" | "unproven" | { readonly problem: string };

function prove(
  record: SpawnRecord,
  seen: Seen | undefined,
  environment: readonly string[] | undefined,
  marker: Marker
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
  if (environment === undefined) {
    return "unproven";
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

/** A record, and the file it was read from. */
interface ReadRecord extends SpawnRecord {
  readonly path: string;
}

interface Records {
  /** The records that could not be read: what they name cannot be stopped. */
  readonly problems: readonly string[];
  readonly records: readonly ReadRecord[];
}

/**
 * Every record under `dir`. One removed meanwhile, by another run's sweep
 * of the same root, is skipped; one that cannot be read is a problem.
 */
function readRecords(dir: string): Records {
  const records: ReadRecord[] = [];
  const problems: string[] = [];
  let entries: string[];
  try {
    entries = listRecords(dir, problems);
  } catch (error) {
    return gone(error)
      ? { problems, records }
      : {
          problems: [`cannot list the records in ${dir}: ${String(error)}`],
          records,
        };
  }
  for (const path of entries) {
    try {
      const record = JSON.parse(readFileSync(path, "utf8")) as SpawnRecord;
      if (
        Number.isInteger(record.pid) &&
        typeof record.group === "boolean" &&
        typeof record.started === "string"
      ) {
        records.push({ ...record, path });
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

/**
 * The record files under `dir`, each directory on the way and each file
 * checked private (`notPrivate`) before it is listed; what is not is
 * skipped, with the reason in `problems`. Files in flight (`.tmp`) are
 * not records yet.
 */
function listRecords(dir: string, problems: string[]): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const problem = notPrivate(dir, "directory");
  if (problem !== undefined) {
    problems.push(`skipped ${problem}`);
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listRecords(path, problems));
    } else if (entry.name.endsWith(".json")) {
      const unsafe = notPrivate(path, "file");
      if (unsafe === undefined) {
        files.push(path);
      } else {
        problems.push(`skipped ${unsafe}`);
      }
    }
  }
  return files;
}

function gone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
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
    return pids.length === 0
      ? new Map()
      : parseLook(
          ps(["-o", "pid=,pgid=,state=,lstart=", "-p", pids.join(",")])
        );
  },
  members(pgid) {
    return parseMembers(ps(["-A", "-o", "pid=,pgid=,state="]), pgid);
  },
  sleep: (ms) => sleep(ms),
};

/**
 * A process that has exited and is waiting to be reaped (state `Z`, a
 * zombie) runs nothing and no signal reaches it: it is gone, as far as a
 * stop goes. Its pid cannot be given to another process until it is
 * reaped, so taking it for gone frees nothing early; counting it as
 * running would wait on it forever where no one reaps it, as in a Linux
 * container whose first process does not.
 */
function exited(state: string): boolean {
  return state.startsWith("Z");
}

/** `ps -o pid=,pgid=,state=,lstart=`, read: the processes that still run. */
export function parseLook(listed: string): Map<number, Seen> {
  const seen = new Map<number, Seen>();
  for (const line of listed.split("\n")) {
    const parsed = LOOK_LINE.exec(line);
    if (parsed && !exited(parsed[3] ?? "")) {
      seen.set(Number(parsed[1]), {
        pgid: Number(parsed[2]),
        started: normal(parsed[4] ?? ""),
      });
    }
  }
  return seen;
}

/** `ps -A -o pid=,pgid=,state=`, read: the processes of `pgid` that still run. */
export function parseMembers(listed: string, pgid: number): number[] {
  return listed
    .split("\n")
    .map((line) => MEMBER_LINE.exec(line))
    .filter(
      (parsed) =>
        parsed !== null &&
        Number(parsed[2]) === pgid &&
        !exited(parsed[3] ?? "")
    )
    .map((parsed) => Number(parsed?.[1]));
}

/** `ps` with its output; it exits 1 when a pid it was given is not running. */
function ps(args: readonly string[]): string {
  const listed = spawnSync("ps", args, {
    encoding: "utf8",
    env: PS_ENV,
    maxBuffer: 256 * 1024 * 1024,
    timeout: PS_TIMEOUT_MS,
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
