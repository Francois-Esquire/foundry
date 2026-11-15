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
 * - a process whose start differs from its record (the pid is someone
 *   else's now): its record is removed, and it is left alone;
 * - one whose start is of another kind than its record's, which says
 *   nothing either way: its record is kept, and reported;
 * - one recorded leading a group of its own that no longer does.
 *
 * An orphan gets SIGTERM, a grace period, SIGKILL, and a last wait. The
 * record of a process confirmed gone is removed; one that would not stop
 * keeps its record and is reported.
 *
 * A group (a record of a leader that leads one) is stopped whole, and its
 * record goes only once no process of the group is left. While a stop
 * proves the leader, it writes the group's members, each with its start,
 * into the record, and signals the group by its id; it keeps doing so
 * until the group is empty, each signal only once a recorded member is
 * proved in the group right then, since a group id cannot be given to
 * another group while any member of this one lives, and a stop that has
 * seen it empty is done with it. A later stop that
 * finds the leader gone, as after a stop cut short, signals each member
 * the record names that it can still prove, and no other process; one
 * whose remaining members it cannot prove keeps the record, reported as
 * pending.
 * Stopping an orphan can leave orphans of its own, its recorded
 * children, so the directory is read again until a pass stops nothing.
 *
 * A process that has exited and waits to be reaped (a zombie) is gone
 * here, whoever it is.
 *
 * Safe to run at any time and more than once, from any process: a
 * process whose owner is alive is never touched, and a stop cut short
 * leaves records that the next run reads again.
 *
 * Node-bound: import it from main-process code only.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  compareStarts,
  groupMembers,
  isGone,
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

/** The system calls a stop makes. */
export interface ProcessTable {
  /** Whether a signal reaches the pid (`processAlive`). */
  alive(pid: number): boolean;
  kill(target: number, signal: NodeJS.Signals): void;
  /**
   * What the system says about each of `pids` that is running; `undefined`
   * when it cannot say.
   */
  look(pids: readonly number[]): ReadonlyMap<number, SeenProcess> | undefined;
  /** Every process in the group `pgid`; `undefined` when it cannot say. */
  members(pgid: number): ReadonlyMap<number, SeenProcess> | undefined;
  sleep(ms: number): Promise<void>;
}

/**
 * The table a stop works with: exited processes left out of what it
 * lists (`running`), and the table as it is (`lookup`), which every
 * judgement that a process is gone goes through (`processState`).
 */
interface Table extends ProcessTable {
  readonly lookup: ProcessLookup;
}

/** A record, and the file it was read from: what it is forgotten by. */
interface ReadRecord extends SpawnRecord {
  readonly path: string;
}

const GRACE_MS = 5000;
const KILL_MS = 2000;
const POLL_MS = 100;
/** Each pass follows the orphans of the last one down a generation. */
const MAX_PASSES = 8;

/** Stop every orphan the recovery records in `dir` name (see above). */
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

/** A group's record, and whether its leader was proved in this look. */
interface OrphanGroup {
  readonly leader: boolean;
  readonly record: ReadRecord;
}

/** The orphans `dir` records now; the records of processes that are gone go. */
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
  const ownerThere =
    record.owner !== undefined && !isGone(record.owner, system.lookup);
  if (record.owner === undefined || ownerThere) {
    // Never an orphan's: its owner is there, or nothing says whose it was.
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

/**
 * Why `identity` cannot be told gone or running: the listing leaves it
 * out while a signal still reaches it, the listing failed, or its start
 * is of another kind than this system reads.
 */
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

/**
 * Why the group `record` leads cannot be told empty: each of its leader
 * and recorded members that is not gone on proof; `undefined` when every
 * one is.
 */
function untold(record: ReadRecord, system: Table): string | undefined {
  const reasons = [record, ...(record.members ?? [])]
    .filter(
      (member, index, all) =>
        all.findIndex((other) => other.pid === member.pid) === index &&
        processState(member, system.lookup) === "unknown"
    )
    .map((member) => cannotTell(member, system));
  return reasons.length === 0 ? undefined : reasons.join("; ");
}

/**
 * What is left of a group whose leader is gone: nothing (`gone`), members
 * its record names that can be proved (`members`), or members it cannot
 * prove, which keep the record, reported.
 */
function leftMembers(record: ReadRecord, system: Table): Verdict {
  const members = system.members(record.pid);
  if (members === undefined) {
    return {
      problem: `the members of group ${String(record.pid)} could not be listed; its record is kept`,
    };
  }
  if (members.size === 0) {
    // Empty only once its leader and every member it records is gone on proof.
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

/**
 * The process `record` names runs now, proved: one has its pid and the
 * start its record says, of the same kind. Only a process proved so is
 * ever signalled.
 */
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

/** SIGTERM, a grace period, SIGKILL, a last wait; each signal on a fresh proof. */
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

/** Signal each of `records` still running as recorded. */
function signal(
  records: readonly ReadRecord[],
  name: NodeJS.Signals,
  system: ProcessTable
): void {
  for (const record of records) {
    // Proved right before its own signal: what an earlier one changed shows.
    const seen = system.look([record.pid]);
    if (seen === undefined || !proved(record, seen)) {
      continue;
    }
    signalTarget(system, record.pid, name);
  }
}

/**
 * Poll until each of `records` is gone on proof (`processState`), or `ms`
 * pass; those that are not: still running, or not to be told gone.
 */
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

/**
 * Stop the group `group` names: whole, by its id, while one of its
 * recorded members (its leader first) is proved in it right before each
 * signal, else each member its record names that is proved right before
 * its signal. Its members are written into its record before any signal,
 * and again as more are seen, so a stop cut short leaves its proof
 * behind. SIGTERM, a grace period, SIGKILL, a last wait; the record goes
 * only once no process of the group is left. `undefined` once it is
 * empty; why its record is kept otherwise.
 *
 * The leader was proved when the records were read, but stopping other
 * orphans since may have taken seconds: the group may have emptied and
 * its id gone to another group meanwhile. So nothing is taken from that
 * proof. A group id is not given to another group while any process of
 * this one lives, so a recorded member found in it, with its recorded
 * start, proves the id is still this group's at that moment.
 */
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
      // The leader is gone since, or its pid is another's: what is left
      // is judged by the members its record names, as a later stop would.
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
    const members = system.members(pgid);
    if (members === undefined) {
      return;
    }
    const known = record.members ?? [];
    if (whole && known.some((member) => proved(member, members))) {
      record = withMembers(record, members);
      signalTarget(system, -pgid, name);
      return;
    }
    for (const member of known) {
      if (proved(member, members)) {
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
  return reasons === undefined
    ? `group ${String(pgid)} still has members after SIGKILL; pending, its record kept`
    : `group ${String(pgid)}: ${reasons}; pending, its record kept`;
}

/**
 * `record` naming every process of `members`, the group as just proved,
 * as well as those it named already; written when that adds one.
 */
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
  // Into the file it was read from, which replaces it whole.
  writePrivate(path, JSON.stringify(stored));
  return next;
}

/** Poll until no process of the group `pgid` is left, or `ms` pass. */
async function emptied(
  record: ReadRecord,
  ms: number,
  system: Table
): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    // No member listed in it, and its leader and every member it records
    // gone on proof: absence from the listing alone proves none gone.
    if (
      system.members(record.pid)?.size === 0 &&
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

/**
 * `table`, with every process that has exited and waits to be reaped (a
 * zombie) left out: it runs nothing and no signal reaches it, so it is
 * gone to a stop, as is an owner that is one. Its pid is not free until
 * it is reaped, so this frees nothing early; counted as running, it would
 * keep its record, and its group's, pending forever where no one reaps it,
 * as in a container whose first process does not.
 */
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
    look: (pids) => live(table.look(pids)),
    // Whether a process is gone is asked of the table as it is, by the one
    // rule (`processState`): exited, unreaped processes listed so.
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
    // Gone between the proof and the signal; a group of exited members
    // not yet reaped answers EPERM on macOS.
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

/**
 * The records directly in `dir`, each file checked private first; one
 * that is not, or cannot be read, is a problem, and names nothing to stop.
 * Files in flight (`.tmp`) are not records yet.
 */
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
      // One removed meanwhile, by another stop, is no problem.
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
  // The record's own start time was read when it was written: always there.
  return (
    typeof group === "boolean" &&
    (owner === undefined || isProcessIdentity(owner)) &&
    (members === undefined ||
      (Array.isArray(members) && members.every(isProcessIdentity))) &&
    isProcessIdentity(value) &&
    value.started !== null
  );
}

/**
 * Remove the file `record` was read from, only if it still names
 * `record`'s process: whatever its name, so one left aside by a removal
 * cut short goes too.
 */
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
