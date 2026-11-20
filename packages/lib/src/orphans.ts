import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  compareStarts,
  groupIdTaken,
  groupMembers,
  groupState,
  isProcessIdentity,
  lookProcesses,
  type ProcessIdentity,
  type ProcessLookup,
  processAlive,
  processState,
  type SeenProcess,
} from "./process-identity";
import {
  forgetRecord,
  notPrivate,
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
  alive(pid: number): boolean;
  kill(target: number, signal: NodeJS.Signals): void;
  look(pids: readonly number[]): ReadonlyMap<number, SeenProcess> | undefined;
  members(pgid: number): ReadonlyMap<number, SeenProcess> | undefined;
  sleep(ms: number): Promise<void>;
}

interface Table extends ProcessTable {
  readonly listed: (
    pgid: number
  ) => ReadonlyMap<number, SeenProcess> | undefined;
  readonly lookup: ProcessLookup;
}

interface ReadRecord extends SpawnRecord {
  readonly path: string;
}

const GRACE_MS = 5000;
const KILL_MS = 2000;
const POLL_MS = 100;
const MAX_PASSES = 8;

export async function stopOrphans(
  dir: string,
  options: OrphanStopOptions = {}
): Promise<OrphanStop> {
  const table = options.system ?? SYSTEM;
  const system = running(table);
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
    const result = await stopAll(found.orphans, system, limits);
    const passStopped = [...result.stopped];
    for (const problem of result.problems) {
      problems.add(problem);
    }
    for (const group of found.groups) {
      const kept = await stopGroup(group, system, limits);
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
  readonly orphans: readonly ReadRecord[];
  readonly problems: readonly string[];
}

interface OrphanGroup {
  readonly leader: boolean;
  readonly record: ReadRecord;
}

function orphansIn(dir: string, system: Table): Found {
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
  const orphans: ReadRecord[] = [];
  const groups: OrphanGroup[] = [];
  for (const record of records) {
    const verdict = judge(record, seen, system);
    if (verdict === "gone") {
      forget(record);
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
  record: ReadRecord,
  seen: ReadonlyMap<number, SeenProcess>,
  system: Table
): Verdict {
  if (record.pid === process.pid) {
    return "kept";
  }
  const state = processState(record, system.lookup);
  if (state === "unknown") {
    return { problem: `${cannotTell(record, system)}, its record kept` };
  }
  const owner =
    record.owner === undefined
      ? undefined
      : processState(record.owner, system.lookup);
  if (owner === "unknown" && state === "running") {
    return { problem: `${ownerUntold(record, system)}, its record kept` };
  }
  const ownerThere = owner === "running" || owner === "unknown";
  if (record.owner === undefined || ownerThere) {
    return state === "running" || (record.group && ownerThere)
      ? "kept"
      : "gone";
  }
  if (!record.group) {
    return state === "running" ? "orphan" : "gone";
  }
  if (state === "running") {
    return seen.get(record.pid)?.pgid === record.pid
      ? "group"
      : {
          problem: `process ${String(record.pid)} was recorded leading its own group and no longer does; not signalled`,
        };
  }
  return leftMembers(record, system);
}

function cannotTell(identity: ProcessIdentity, system: Table): string {
  const pid = String(identity.pid);
  const seen = system.lookup.look([identity.pid]);
  if (seen === undefined) {
    return `process ${pid} could not be listed; not signalled`;
  }
  return seen.has(identity.pid)
    ? `process ${pid} runs, and its record names a start of another kind than this system reads; not signalled`
    : `process ${pid} is not listed but a signal still reaches it; not signalled`;
}

function ownerUntold(record: ReadRecord, system: Table): string {
  const { owner } = record;
  const pid = String(owner?.pid);
  const child = `process ${String(record.pid)}`;
  if (owner === undefined) {
    return `${child} names no owner`;
  }
  const seen = system.lookup.look([owner.pid]);
  let why: string;
  if (seen === undefined) {
    why = "it could not be listed";
  } else if (!seen.has(owner.pid)) {
    why = "it is not listed but a signal still reaches it";
  } else if (owner.started === null) {
    why = "its record names no start, and a process runs with its pid";
  } else {
    why = "its start is of another kind than this system reads";
  }
  return `owner ${pid} of ${child} cannot be told gone or running: ${why}; ${child} is not signalled`;
}

function stillRunning(record: ReadRecord, system: Table): ProcessIdentity[] {
  return distinct([record, ...(record.members ?? [])]).filter(
    (member) => processState(member, system.lookup) === "running"
  );
}

function distinct(members: readonly ProcessIdentity[]): ProcessIdentity[] {
  return members.filter(
    (member, index) =>
      members.findIndex((other) => other.pid === member.pid) === index
  );
}

function inGroup(
  record: ReadRecord,
  system: Table
): ReadonlyMap<number, SeenProcess> | undefined {
  return idTaken(record, system) ? new Map() : system.members(record.pid);
}

function idTaken(record: ReadRecord, system: Table): boolean {
  const leader = system.lookup.look([record.pid]);
  return leader !== undefined && groupIdTaken(record, leader.get(record.pid));
}

function groupNow(
  record: ReadRecord,
  system: Table
): "empty" | "running" | "unknown" {
  if (idTaken(record, system)) {
    return "empty";
  }
  return groupState(system.listed(record.pid), system.alive(-record.pid));
}

function groupUntold(record: ReadRecord, system: Table): string {
  const pgid = String(record.pid);
  return system.listed(record.pid) === undefined
    ? `the members of group ${pgid} could not be listed`
    : `group ${pgid} is not listed but a signal still reaches it; not signalled`;
}

function untold(record: ReadRecord, system: Table): string | undefined {
  const reasons = distinct([record, ...(record.members ?? [])])
    .filter((member) => processState(member, system.lookup) === "unknown")
    .map((member) => cannotTell(member, system));
  return reasons.length === 0 ? undefined : reasons.join("; ");
}

function leftMembers(record: ReadRecord, system: Table): Verdict {
  const members = inGroup(record, system);
  if (members === undefined) {
    return {
      problem: `the members of group ${String(record.pid)} could not be listed; its record is kept`,
    };
  }
  if (stillRunning(record, system).length > 0) {
    return "members";
  }
  if (members.size === 0) {
    if (groupNow(record, system) === "unknown") {
      return { problem: `${groupUntold(record, system)}, its record kept` };
    }
    const reasons = untold(record, system);
    return reasons === undefined
      ? "gone"
      : {
          problem: `group ${String(record.pid)}: ${reasons}; pending, its record kept`,
        };
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

async function stopAll(
  orphans: readonly ReadRecord[],
  system: Table,
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
  for (const record of orphans) {
    if (!survivors.has(record.pid)) {
      forget(record);
    }
  }
  return {
    problems: left.map((record) =>
      processState(record, system.lookup) === "running"
        ? `process ${String(record.pid)} would not stop; its record is kept`
        : `${cannotTell(record, system)}, its record kept`
    ),
    stopped,
  };
}

function signal(
  records: readonly ReadRecord[],
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
  records: readonly ReadRecord[],
  ms: number,
  system: Table
): Promise<ReadRecord[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const left = records.filter(
      (record) => processState(record, system.lookup) !== "gone"
    );
    if (left.length === 0 || Date.now() >= deadline) {
      return left;
    }
    await system.sleep(POLL_MS);
  }
}

async function stopGroup(
  group: OrphanGroup,
  system: Table,
  limits: { readonly graceMs: number; readonly killMs: number }
): Promise<string | undefined> {
  const pgid = group.record.pid;
  let { record } = group;
  let whole = group.leader;
  if (whole) {
    const members = system.members(pgid);
    if (members === undefined) {
      return `the members of group ${String(pgid)} could not be listed; its record is kept`;
    }
    if (proved(record, members)) {
      record = withMembers(record, members);
    } else {
      whole = false;
      const left = leftMembers(record, system);
      if (left === "gone") {
        forget(record);
        return;
      }
      if (typeof left === "object") {
        return left.problem;
      }
    }
  }
  const send = (name: NodeJS.Signals): void => {
    const members = inGroup(record, system);
    const known = record.members ?? [];
    let reached = new Set<number>();
    if (
      whole &&
      members !== undefined &&
      known.some((member) => proved(member, members))
    ) {
      record = withMembers(record, members);
      signalTarget(system, -pgid, name);
      reached = new Set(members.keys());
    }
    for (const member of stillRunning(record, system)) {
      if (!reached.has(member.pid)) {
        signalTarget(system, member.pid, name);
      }
    }
  };
  for (const [name, ms] of [
    ["SIGTERM", limits.graceMs],
    ["SIGKILL", limits.killMs],
  ] as const) {
    send(name);
    if (await emptied(record, ms, system)) {
      forget(record);
      return;
    }
  }
  const reasons = untold(record, system);
  const stubborn = stillRunning(record, system).map(({ pid }) => String(pid));
  if (groupNow(record, system) === "unknown") {
    return `${groupUntold(record, system)}, its record kept`;
  }
  if (reasons !== undefined) {
    return `group ${String(pgid)}: ${reasons}; pending, its record kept`;
  }
  return stubborn.length > 0
    ? `group ${String(pgid)}: recorded member(s) ${stubborn.join(", ")} would not stop; its record kept`
    : `group ${String(pgid)} still has members after SIGKILL; pending, its record kept`;
}

function withMembers(
  record: ReadRecord,
  members: ReadonlyMap<number, SeenProcess>
): ReadRecord {
  const known = record.members ?? [];
  const added = [...members]
    .filter(([pid, seen]) =>
      known.every(
        (member) =>
          member.pid !== pid ||
          compareStarts(member.started, seen.started) !== "same"
      )
    )
    .map(([pid, seen]) => ({ pid, started: seen.started }));
  if (added.length === 0 && record.members !== undefined) {
    return record;
  }
  const next = { ...record, members: [...known, ...added] };
  const { path, ...stored } = next;
  writePrivate(path, JSON.stringify(stored));
  return next;
}

async function emptied(
  record: ReadRecord,
  ms: number,
  system: Table
): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (
      groupNow(record, system) === "empty" &&
      stillRunning(record, system).length === 0 &&
      untold(record, system) === undefined
    ) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await system.sleep(POLL_MS);
  }
}

function running(table: ProcessTable): Table {
  const live = (
    seen: ReadonlyMap<number, SeenProcess> | undefined
  ): ReadonlyMap<number, SeenProcess> | undefined =>
    seen === undefined
      ? undefined
      : new Map([...seen].filter(([, entry]) => entry.exited !== true));
  return {
    alive: (pid) => table.alive(pid),
    kill: (target, name) => table.kill(target, name),
    listed: (pgid) => table.members(pgid),
    look: (pids) => live(table.look(pids)),
    lookup: {
      alive: (pid) => table.alive(pid),
      look: (pids) => table.look(pids),
    },
    members: (pgid) => live(table.members(pgid)),
    sleep: (ms) => table.sleep(ms),
  };
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
  readonly records: readonly ReadRecord[];
}

function readRecords(dir: string): Records {
  const problems: string[] = [];
  const records: ReadRecord[] = [];
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

function forget(record: ReadRecord): void {
  forgetRecord(record.path, record);
}

function gone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

const SYSTEM: ProcessTable = {
  alive: processAlive,
  kill: (target, name) => process.kill(target, name),
  look: lookProcesses,
  members: groupMembers,
  sleep: (ms) => sleep(ms),
};
