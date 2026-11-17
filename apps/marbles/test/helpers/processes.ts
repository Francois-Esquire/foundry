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

export interface Marker {
  readonly name: string;
  readonly value: string;
}

export interface StopLimits {
  readonly graceMs: number;
  readonly killMs: number;
}

interface Seen {
  readonly exited?: true;
  readonly pgid: number;
  readonly started: string;
}

export interface ProcessSystem {
  alive(pid: number): boolean;
  environment(pid: number): readonly string[] | undefined;
  kill(target: number, signal: NodeJS.Signals): void;
  look(pids: readonly number[]): ReadonlyMap<number, Seen>;
  members(pgid: number): readonly number[];
  sleep(ms: number): Promise<void>;
}

const LIMITS: StopLimits = { graceMs: 5000, killMs: 2000 };
const POLL_MS = 100;
const MAX_PASSES = 8;
const STALE_PARTIAL_MS = 60_000;
const PS_TIMEOUT_MS = 5000;
const PS_ENV = { ...process.env, LC_ALL: "C", TZ: "UTC" };
const LOOK_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/;
const MEMBER_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/;
const COMMAND_LINE = /^\s*(\d+) (.*)$/;
const PID = /^\d+$/;
const SPACES = /\s+/g;
const START_KIND = /^[a-z]+:/;

export function recordProcess(dir: string, pid: number, group: boolean): void {
  recordSpawned(pid, group, { [SPAWN_RECORD_ENV]: dir });
}

export async function stopRecorded(
  dir: string,
  marker: Marker,
  limits: StopLimits = LIMITS,
  system: ProcessSystem = SYSTEM
): Promise<string[]> {
  const problems = new Set<string>();
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
      if (problems.size > 0 || removeEmpty(dir).length === 0) {
        return [...problems];
      }
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
  const left = removeEmpty(dir);
  if (left.length > 0) {
    problems.add(
      `${dir} still held, after ${String(MAX_PASSES)} passes, ${left.join(", ")}; kept, not clear`
    );
  }
  return [...problems];
}

function handledKey(record: ReadRecord): string {
  return `${record.path}\n${record.started}`;
}

export interface RecordFiles {
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

function removeEmpty(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (gone(error)) {
      return [];
    }
    throw error;
  }
  const left: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      left.push(...removeEmpty(path));
    } else if (entry.name.endsWith(".tmp")) {
      if (stale(path)) {
        rmSync(path, { force: true });
      } else {
        left.push(`${path}, a record still being written`);
      }
    } else {
      left.push(
        entry.name.endsWith(".json")
          ? `${path}, a record written since`
          : `${path}, not a record`
      );
    }
  }
  if (left.length > 0) {
    return left;
  }
  try {
    rmdirSync(dir);
    return [];
  } catch (error) {
    return gone(error) ? [] : [`${dir}, which gained an entry`];
  }
}

function stale(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > STALE_PARTIAL_MS;
  } catch {
    return true;
  }
}

class RecordedStop {
  readonly #records: readonly SpawnRecord[];
  readonly #recorded: ReadonlySet<number>;
  readonly #marker: Marker;
  readonly #system: ProcessSystem;
  readonly #problems = new Map<number, string>();
  readonly #unreadable: readonly string[];
  #unproven = new Set<number>();
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

  round(signal: NodeJS.Signals | undefined): number[] {
    const left: number[] = [];
    this.#unproven = new Set();
    for (const record of this.#records) {
      if (this.#problems.has(record.pid)) {
        continue;
      }
      const environment = this.#system.environment(record.pid);
      const found = this.#system.look([record.pid]).get(record.pid);
      const proof = prove(
        record,
        found,
        environment,
        this.#marker,
        this.#system
      );
      if (typeof proof === "object") {
        this.#problems.set(record.pid, proof.problem);
      } else if (proof === "recorded") {
        this.#signal(record, signal);
        left.push(record.pid);
      } else if (proof === "unproven") {
        this.#unproven.add(record.pid);
        left.push(record.pid);
      } else if (record.group && groupMayRemain(record, found)) {
        this.#groups.add(record.pid);
      }
    }
    return left;
  }

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

  #remnants(): [number, number][] {
    return [...this.#groups].flatMap((pgid) =>
      this.#system
        .members(pgid)
        .filter((pid) => !this.#recorded.has(pid))
        .map((pid): [number, number] => [pid, pgid])
    );
  }
}

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

type Proof = "gone" | "recorded" | "unproven" | { readonly problem: string };

function groupMayRemain(record: SpawnRecord, found: Seen | undefined): boolean {
  return (
    found === undefined || (found.exited === true && found.pgid === record.pid)
  );
}

function prove(
  record: SpawnRecord,
  seen: Seen | undefined,
  environment: readonly string[] | undefined,
  marker: Marker,
  system: Pick<ProcessSystem, "alive">
): Proof {
  const pid = String(record.pid);
  if (seen?.exited === true) {
    return "gone";
  }
  if (seen === undefined) {
    return system.alive(record.pid)
      ? {
          problem: `process ${pid} is not listed but a signal still reaches it; not signalled, its record kept`,
        }
      : "gone";
  }
  if (otherKind(record.started)) {
    return {
      problem: `process ${pid}'s record names a start of a kind this reader cannot compare (${record.started}); not signalled, its record kept`,
    };
  }
  if (seen.started !== normal(record.started)) {
    return "gone";
  }
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

export function otherKind(started: string): boolean {
  return START_KIND.test(started);
}

export function signalReaches(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalIfThere(
  system: ProcessSystem,
  target: number,
  signal: NodeJS.Signals
): void {
  try {
    system.kill(target, signal);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== "ESRCH" && code !== "EPERM") {
      throw error;
    }
  }
}

interface ReadRecord extends SpawnRecord {
  readonly path: string;
}

interface Records {
  readonly problems: readonly string[];
  readonly records: readonly ReadRecord[];
}

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
  alive: signalReaches,
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

function exited(state: string): boolean {
  return state.startsWith("Z");
}

export function parseLook(listed: string): Map<number, Seen> {
  const seen = new Map<number, Seen>();
  for (const line of listed.split("\n")) {
    const parsed = LOOK_LINE.exec(line);
    if (parsed) {
      seen.set(Number(parsed[1]), {
        ...(exited(parsed[3] ?? "") ? { exited: true as const } : {}),
        pgid: Number(parsed[2]),
        started: normal(parsed[4] ?? ""),
      });
    }
  }
  return seen;
}

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

function linuxEnvironment(pid: number): readonly string[] | undefined {
  try {
    return readFileSync(`/proc/${String(pid)}/environ`, "utf8")
      .split("\0")
      .filter((entry) => entry !== "");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : [];
  }
}
