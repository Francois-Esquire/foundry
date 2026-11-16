import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  compareStarts,
  groupMembers,
  isProcessIdentity,
  lookProcesses,
  type ProcessIdentity,
  type SeenProcess,
} from "./process-identity";
import {
  notPrivate,
  recordPath,
  type SpawnRecord,
  writePrivate,
} from "./spawn-record";

export interface OrphanStop {
  readonly problems: readonly string[];
  readonly stopped: readonly number[];
}

export interface OrphanStopOptions {
  readonly graceMs?: number;
  readonly killMs?: number;
  readonly system?: ProcessTable;
}

export interface ProcessTable {
  kill(target: number, signal: NodeJS.Signals): void;
  look(pids: readonly number[]): ReadonlyMap<number, SeenProcess> | undefined;
  members(pgid: number): ReadonlyMap<number, SeenProcess> | undefined;
  sleep(ms: number): Promise<void>;
}

const GRACE_MS = 5000;
const KILL_MS = 2000;
const POLL_MS = 100;
const MAX_PASSES = 8;

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
    if (found.orphans.length === 0 && found.groups.length === 0) {
      break;
    }
    const result = await stopAll(dir, found.orphans, system, limits);
    const passStopped = [...result.stopped];
    for (const problem of result.problems) {
      problems.add(problem);
    }
    for (const group of found.groups) {
      const kept = await stopGroup(dir, group, system, limits);
      if (kept === undefined) {
        passStopped.push(group.record.pid);
      } else {
        problems.add(kept);
      }
    }
    stopped.push(...passStopped);
    if (passStopped.length === 0) {
      break;
    }
  }
  return { problems: [...problems], stopped };
}

interface Found {
  readonly groups: readonly OrphanGroup[];
  readonly orphans: readonly SpawnRecord[];
  readonly problems: readonly string[];
}

interface OrphanGroup {
  readonly leader: boolean;
  readonly record: SpawnRecord;
}

function orphansIn(dir: string, system: ProcessTable): Found {
  const { problems, records } = readRecords(dir);
  const pids = records.flatMap((record) =>
    record.owner === undefined ? [record.pid] : [record.pid, record.owner.pid]
  );
  const seen = system.look([...new Set(pids)]);
  if (seen === undefined) {
    return {
      groups: [],
      orphans: [],
      problems: [...problems, "ps could not list the recorded processes"],
    };
  }
  const orphans: SpawnRecord[] = [];
  const groups: OrphanGroup[] = [];
  for (const record of records) {
    const verdict = judge(record, seen, system);
    if (verdict === "gone") {
      forget(dir, record.pid);
    } else if (verdict === "orphan") {
      orphans.push(record);
    } else if (verdict === "group" || verdict === "members") {
      groups.push({ leader: verdict === "group", record });
    } else if (typeof verdict === "object") {
      problems.push(verdict.problem);
    }
  }
  return { groups, orphans, problems };
}

type Verdict =
  | "gone"
  | "group"
  | "kept"
  | "members"
  | "orphan"
  | { readonly problem: string };

function judge(
  record: SpawnRecord,
  seen: ReadonlyMap<number, SeenProcess>,
  system: ProcessTable
): Verdict {
  if (record.pid === process.pid) {
    return "kept";
  }
  const found = seen.get(record.pid);
  const start =
    found === undefined
      ? "absent"
      : compareStarts(found.started, record.started);
  if (start === "unknown") {
    return {
      problem: `process ${String(record.pid)} runs, and its record names a start of another kind than this system reads; not signalled, its record kept`,
    };
  }
  if (record.owner !== undefined && stillThere(record.owner, seen)) {
    return start === "same" || record.group ? "kept" : "gone";
  }
  if (record.owner === undefined) {
    return start === "same" ? "kept" : "gone";
  }
  if (!record.group) {
    return start === "same" ? "orphan" : "gone";
  }
  if (start === "same") {
    return found?.pgid === record.pid
      ? "group"
      : {
          problem: `process ${String(record.pid)} was recorded leading its own group and no longer does; not signalled`,
        };
  }
  return leftMembers(record, system);
}

function leftMembers(record: SpawnRecord, system: ProcessTable): Verdict {
  const members = system.members(record.pid);
  if (members === undefined) {
    return {
      problem: `the members of group ${String(record.pid)} could not be listed; its record is kept`,
    };
  }
  if (members.size === 0) {
    return "gone";
  }
  return (record.members ?? []).some((member) => proved(member, members))
    ? "members"
    : {
        problem: `group ${String(record.pid)}'s leader is gone and its ${String(members.size)} remaining member(s) cannot be proved its; not signalled, pending, its record kept`,
      };
}

function proved(
  record: ProcessIdentity,
  seen: ReadonlyMap<number, SeenProcess>
): boolean {
  const found = seen.get(record.pid);
  return (
    found !== undefined &&
    compareStarts(found.started, record.started) === "same"
  );
}

function stillThere(
  owner: ProcessIdentity,
  seen: ReadonlyMap<number, SeenProcess>
): boolean {
  const found = seen.get(owner.pid);
  return (
    found !== undefined &&
    compareStarts(found.started, owner.started) !== "different"
  );
}

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

function signal(
  records: readonly SpawnRecord[],
  name: NodeJS.Signals,
  system: ProcessTable
): void {
  for (const record of records) {
    const seen = system.look([record.pid]);
    if (seen === undefined || !proved(record, seen)) {
      continue;
    }
    signalTarget(system, record.pid, name);
  }
}

async function waitGone(
  records: readonly SpawnRecord[],
  ms: number,
  system: ProcessTable
): Promise<SpawnRecord[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const seen = system.look(records.map(({ pid }) => pid));
    const left =
      seen === undefined
        ? [...records]
        : records.filter((record) => proved(record, seen));
    if (left.length === 0 || Date.now() >= deadline) {
      return left;
    }
    await system.sleep(POLL_MS);
  }
}

async function stopGroup(
  dir: string,
  group: OrphanGroup,
  system: ProcessTable,
  limits: { readonly graceMs: number; readonly killMs: number }
): Promise<string | undefined> {
  const pgid = group.record.pid;
  let { record } = group;
  if (group.leader) {
    const members = system.members(pgid);
    if (members === undefined) {
      return `the members of group ${String(pgid)} could not be listed; its record is kept`;
    }
    record = {
      ...record,
      members: [...members].map(([pid, seen]) => ({
        pid,
        started: seen.started,
      })),
    };
    writePrivate(recordPath(dir, pgid), JSON.stringify(record));
  }
  const send = (name: NodeJS.Signals): void => {
    if (group.leader) {
      signalTarget(system, -pgid, name);
      return;
    }
    const members = system.members(pgid);
    for (const member of record.members ?? []) {
      if (members !== undefined && proved(member, members)) {
        signalTarget(system, member.pid, name);
      }
    }
  };
  for (const [name, ms] of [
    ["SIGTERM", limits.graceMs],
    ["SIGKILL", limits.killMs],
  ] as const) {
    send(name);
    if (await emptied(pgid, ms, system)) {
      forget(dir, pgid);
      return;
    }
  }
  return `group ${String(pgid)} still has members after SIGKILL; pending, its record kept`;
}

async function emptied(
  pgid: number,
  ms: number,
  system: ProcessTable
): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (system.members(pgid)?.size === 0) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await system.sleep(POLL_MS);
  }
}

function signalTarget(
  system: ProcessTable,
  target: number,
  name: NodeJS.Signals
): void {
  try {
    system.kill(target, name);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== "ESRCH" && code !== "EPERM") {
      throw error;
    }
  }
}

interface Records {
  readonly problems: string[];
  readonly records: readonly SpawnRecord[];
}

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
  const { group, members, owner } = value as Partial<SpawnRecord>;
  return (
    typeof group === "boolean" &&
    (owner === undefined || isProcessIdentity(owner)) &&
    (members === undefined ||
      (Array.isArray(members) && members.every(isProcessIdentity))) &&
    isProcessIdentity(value) &&
    value.started !== null
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
  look: lookProcesses,
  members: groupMembers,
  sleep: (ms) => sleep(ms),
};
