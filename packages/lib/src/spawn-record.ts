/**
 * Records of the processes Foundry starts in the background, for whoever
 * has to find them again after the process that started them is gone:
 * the Marbles test suite, which stops exactly what its runs started, and
 * the next start of a Marbles engine, which stops what an engine that is
 * gone left running (`@foundry/lib/orphans`).
 *
 * The contract:
 *
 * - Active only while `MARBLES_SPAWN_RECORD` (every record, for a test
 *   run) or `MARBLES_SPAWN_RECOVERY` (the records a later start recovers
 *   from) names a directory in the environment the caller passes (by
 *   default this process's). Neither set, `recordSpawned` returns at once
 *   and runs nothing.
 * - A recovery record also names its owner, the process that recorded it,
 *   by pid and start time. It is removed when the child exits, if the
 *   caller handed the child itself over (`recordChild`), so the directory
 *   holds only what may still be running.
 * - Each directory must be private: a real directory (not a link), owned
 *   by this user, with no permission for group or others. A missing one
 *   is created so. Anything else is refused.
 * - Each record is one file, `<pid>.json`, holding the pid, whether the
 *   process leads a process group of its own, and its start time as `ps`
 *   reports it in UTC, so a later reader can tell it from another process
 *   given the same pid since. It is written to a fresh file created
 *   exclusively, without following links, under an unpredictable name,
 *   and then renamed into place.
 * - It never throws into a spawn path and never holds one up for long: a
 *   record that cannot be made is reported once per process on stderr,
 *   and the start goes on. The suite that asked for records catches the
 *   missing one when it ends.
 *
 * Node-bound: import it from main-process code only.
 */

import {
  type ChildProcess,
  type ExecFileOptions,
  execFile,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  compareStarts,
  groupMembers,
  type ProcessIdentity,
  type SeenProcess,
  startedAt,
  thisProcess,
} from "./process-identity";

export interface SpawnRecord {
  /** It leads a process group of its own, whose id is its pid. */
  readonly group: boolean;
  /**
   * On a group's record: its members as a stop found them while it could
   * still prove the group by its leader, so a later stop can prove each
   * one after the leader is gone.
   */
  readonly members?: readonly ProcessIdentity[];
  /** The process that started it, on a recovery record. */
  readonly owner?: ProcessIdentity;
  readonly pid: number;
  /** As `startedAt` reads it. */
  readonly started: string;
}

/** The directory every record goes to: a test run's. */
export const SPAWN_RECORD_ENV = "MARBLES_SPAWN_RECORD";
/**
 * The directory recovery records go to: what a later start reads to stop
 * the children of a process that is gone (`@foundry/lib/orphans`).
 */
export const SPAWN_RECOVERY_ENV = "MARBLES_SPAWN_RECOVERY";
/**
 * An owner's mark, carried to every child, that a reader of the records
 * can check a process's environment for.
 */
export const SPAWN_OWNER_ENV = "MARBLES_SPAWN_OWNER";

/** Create a new file, never an existing one, and never through a link. */
const CREATE =
  // biome-ignore lint/suspicious/noBitwiseOperators: open(2) takes its flags as one bit set.
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW |
  constants.O_WRONLY;

let reported = false;

/**
 * The recorder's own variables in `env`, for a child started with an
 * environment of its own choosing, so what it starts is recorded and
 * marked too. Empty when recording is off.
 */
export function spawnRecordEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const carried: Record<string, string> = {};
  for (const name of [SPAWN_RECORD_ENV, SPAWN_RECOVERY_ENV, SPAWN_OWNER_ENV]) {
    const value = env[name];
    if (value !== undefined && value !== "") {
      carried[name] = value;
    }
  }
  return carried;
}

/**
 * Why `path` is not private, as the records need it, or `undefined` when
 * it is: a real `kind` (no link), owned by this user, with no permission
 * for group or others.
 */
export function notPrivate(
  path: string,
  kind: "directory" | "file"
): string | undefined {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (error) {
    return `${path} cannot be read: ${String(error)}`;
  }
  if (stats.isSymbolicLink()) {
    return `${path} is a symbolic link`;
  }
  if (kind === "directory" ? !stats.isDirectory() : !stats.isFile()) {
    return `${path} is not a ${kind}`;
  }
  if (process.getuid !== undefined && stats.uid !== process.getuid()) {
    return `${path} belongs to another user`;
  }
  // The low six bits are the group's and others' permissions.
  if (stats.mode % 0o100 !== 0) {
    return `${path} is open to group or others (mode ${(stats.mode % 0o1000).toString(8)})`;
  }
}

/**
 * Record `pid`, which this process has just started, if `env` asks for
 * records (see the contract above). Call it in the same turn as the
 * spawn, once the child is the caller's: until this process reaps it,
 * which waits for its event loop, no other process can be given that pid.
 * Prefer `recordChild` when the child itself is at hand: its recovery
 * record then goes when it exits.
 */
export function recordSpawned(
  pid: number | undefined,
  group: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env
): void {
  const all = named(env[SPAWN_RECORD_ENV]);
  const recovery = named(env[SPAWN_RECOVERY_ENV]);
  if ((all === undefined && recovery === undefined) || pid === undefined) {
    return;
  }
  try {
    write(pid, group, all, recovery);
  } catch (error) {
    if (!reported) {
      reported = true;
      process.stderr.write(
        `foundry: could not record process ${String(pid)} in ${[all, recovery].filter(Boolean).join(" and ")}: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }
}

/**
 * Record `child`, as `recordSpawned` does, and remove its recovery record
 * once it exits: it is reaped then, so the record names nothing.
 */
export function recordChild(
  child: Pick<ChildProcess, "once" | "pid">,
  group = false,
  env: Readonly<Record<string, string | undefined>> = process.env
): void {
  recordSpawned(child.pid, group, env);
  const recovery = named(env[SPAWN_RECOVERY_ENV]);
  const { pid } = child;
  if (recovery !== undefined && pid !== undefined) {
    child.once("exit", () => {
      // The exit is its reaping: no later child can have had this pid yet.
      rmSync(recordPath(recovery, pid), { force: true });
    });
  }
}

/** How a group stop reaches the system; a test replaces it. */
export interface GroupSystem {
  /** Signal `target` (a negative pid: the group); throws as `process.kill` does. */
  kill(target: number, signal: NodeJS.Signals | 0): void;
  /** Every process in the group `pgid`; `undefined` when the system cannot say. */
  members(pgid: number): ReadonlyMap<number, SeenProcess> | undefined;
  sleep(ms: number): Promise<void>;
}

export interface RecordGroupOptions {
  /** Read for the record directories; this process's environment when omitted. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** How long the group gets after SIGTERM, then after SIGKILL. */
  readonly graceMs?: number;
  readonly killMs?: number;
  /** When it aborts, the whole group is stopped. */
  readonly signal?: AbortSignal;
  readonly system?: GroupSystem;
}

const GROUP_GRACE_MS = 2000;
const GROUP_KILL_MS = 1000;
const GROUP_POLL_MS = 50;

const GROUP_SYSTEM: GroupSystem = {
  kill: (target, signal) => process.kill(target, signal),
  members: groupMembers,
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
};

/**
 * Record `child`, which leads a process group of its own (spawned
 * detached), as a group, and stop the whole group, the leader and
 * whatever it started, when `signal` aborts and once the leader exits:
 * SIGTERM, a grace period, SIGKILL, a last wait. Its recovery record goes
 * only once the group is empty; one that would not empty keeps it, so the
 * next start's orphan stop finds the group (`@foundry/lib/orphans`).
 * Before the first signal, the group's members, each with its start, are
 * written into that record, so a start after this process died mid-stop
 * can prove each one once the leader is gone.
 *
 * The group's id is this one's while the leader is not yet reaped, and
 * the stop that follows its exit runs in the same turn as its reaping.
 * The SIGKILL comes a grace period later, so it goes to the group only
 * while a member recorded at the start is proved still in it (a group id
 * cannot go to another group while any of its processes lives); else
 * nothing is sent, and the record stays for the next start. A process
 * that has exited and waits to be reaped (a zombie) is not left in the
 * group as far as the stop goes.
 *
 * Returns the stop, which resolves with whether the group emptied.
 */
export function recordGroup(
  child: Pick<ChildProcess, "once" | "pid">,
  options: RecordGroupOptions = {}
): () => Promise<boolean> {
  const env = options.env ?? process.env;
  const { pid } = child;
  recordSpawned(pid, true, env);
  if (pid === undefined) {
    return () => Promise.resolve(true);
  }
  const recovery = named(env[SPAWN_RECOVERY_ENV]);
  const system = options.system ?? GROUP_SYSTEM;
  let reaped = false;
  let stopping: Promise<boolean> | undefined;
  const stop = (): Promise<boolean> => {
    stopping ??= stopGroup(pid, system, {
      graceMs: options.graceMs ?? GROUP_GRACE_MS,
      held: () => !reaped,
      killMs: options.killMs ?? GROUP_KILL_MS,
      ...(recovery === undefined ? {} : { record: recordPath(recovery, pid) }),
    }).then((emptied) => {
      if (emptied && recovery !== undefined) {
        rmSync(recordPath(recovery, pid), { force: true });
      }
      return emptied;
    });
    return stopping;
  };
  options.signal?.addEventListener("abort", () => stop().catch(() => false), {
    once: true,
  });
  // Its exit is its reaping; what it started may still run in its group.
  child.once("exit", () => {
    reaped = true;
    stop().catch(() => false);
  });
  return stop;
}

interface GroupStop {
  readonly graceMs: number;
  /** Whether the leader is not yet reaped, so its pid, the group's id, is still this process's. */
  readonly held: () => boolean;
  readonly killMs: number;
  /** The group's recovery record, which its members are written into. */
  readonly record?: string;
}

/**
 * SIGTERM the group `pgid`, wait, SIGKILL it if it is still proved this
 * one, wait; whether it emptied.
 */
async function stopGroup(
  pgid: number,
  system: GroupSystem,
  stop: GroupStop
): Promise<boolean> {
  if (!groupSignal(system, pgid, 0)) {
    return true;
  }
  let known = running(system.members(pgid));
  if (known?.size === 0) {
    return true;
  }
  if (known !== undefined) {
    // Before any signal, so a stop cut short leaves its proof behind.
    saveMembers(stop.record, known);
  }
  for (const [signal, ms] of [
    ["SIGTERM", stop.graceMs],
    ["SIGKILL", stop.killMs],
  ] as const) {
    if (signal === "SIGKILL") {
      const now = running(system.members(pgid));
      if (now?.size === 0) {
        return true;
      }
      if (now === undefined || !(stop.held() || provedIn(known, now))) {
        // Nothing proves the id still this group's: the next start decides.
        return false;
      }
      known = now;
      saveMembers(stop.record, now);
    }
    if (!groupSignal(system, pgid, signal)) {
      return true;
    }
    if (await emptiedWithin(system, pgid, ms)) {
      return true;
    }
  }
  return false;
}

/** Poll the group `pgid` until it has no process left that runs, or `ms` pass. */
async function emptiedWithin(
  system: GroupSystem,
  pgid: number,
  ms: number
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await system.sleep(GROUP_POLL_MS);
    if (!groupSignal(system, pgid, 0)) {
      return true;
    }
  }
  // It answers a signal; whether only exited, unreaped members (zombies) do.
  return running(system.members(pgid))?.size === 0;
}

/** `members`, without those that have exited and wait to be reaped (zombies). */
function running(
  members: ReadonlyMap<number, SeenProcess> | undefined
): ReadonlyMap<number, SeenProcess> | undefined {
  return members === undefined
    ? undefined
    : new Map([...members].filter(([, seen]) => seen.exited !== true));
}

/** Whether a process of `known` is in `now`, with the same start. */
function provedIn(
  known: ReadonlyMap<number, SeenProcess> | undefined,
  now: ReadonlyMap<number, SeenProcess>
): boolean {
  return [...(known ?? [])].some(([pid, seen]) => {
    const found = now.get(pid);
    return (
      found !== undefined &&
      compareStarts(found.started, seen.started) === "same"
    );
  });
}

/**
 * Write `members` into the group's record at `path`, with those it
 * names already. Best effort: a stop goes on without it, as without a
 * record at all.
 */
function saveMembers(
  path: string | undefined,
  members: ReadonlyMap<number, SeenProcess>
): void {
  if (path === undefined) {
    return;
  }
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as SpawnRecord;
    const known = record.members ?? [];
    const added = [...members]
      .filter(([pid, seen]) =>
        known.every(
          (member) =>
            member.pid !== pid ||
            compareStarts(member.started, seen.started) !== "same"
        )
      )
      .map(([pid, seen]): ProcessIdentity => ({ pid, started: seen.started }));
    if (added.length > 0 || record.members === undefined) {
      writePrivate(
        path,
        JSON.stringify({ ...record, members: [...known, ...added] })
      );
    }
  } catch {
    // No record to add them to (none was made, or it is gone), or one
    // that cannot be written: the stop goes on, as it would without one.
  }
}

/** Signal the group `pgid`; `false` once it has no process left. */
function groupSignal(
  system: GroupSystem,
  pgid: number,
  signal: NodeJS.Signals | 0
): boolean {
  try {
    system.kill(-pgid, signal);
    return true;
  } catch (error) {
    // A group of exited members not yet reaped answers EPERM on macOS.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Where the record of `pid` is kept in `dir`. */
export function recordPath(dir: string, pid: number): string {
  return join(dir, `${String(pid)}.json`);
}

function named(dir: string | undefined): string | undefined {
  return dir === undefined || dir === "" ? undefined : dir;
}

function write(
  pid: number,
  group: boolean,
  all: string | undefined,
  recovery: string | undefined
): void {
  for (const dir of [all, recovery]) {
    if (dir !== undefined) {
      privateDirectory(dir);
    }
  }
  const started = startedAt(pid);
  if (started === null) {
    // It has already exited and been reaped: nothing is left to record.
    return;
  }
  if (started === undefined) {
    throw new Error("ps could not say when it started");
  }
  const record: SpawnRecord = { group, pid, started };
  if (all !== undefined) {
    writePrivate(recordPath(all, pid), JSON.stringify(record));
  }
  if (recovery !== undefined) {
    const owner: ProcessIdentity = thisProcess();
    writePrivate(
      recordPath(recovery, pid),
      JSON.stringify({ ...record, owner })
    );
  }
}

/** Make `dir`, private, if it is missing; refuse one that is not private. */
function privateDirectory(dir: string): void {
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const problem = notPrivate(dir, "directory");
  if (problem !== undefined) {
    throw new Error(problem);
  }
}

/**
 * Write `text` to `path`, readable by this user alone: to a fresh file
 * beside it under an unpredictable name, created exclusively and without
 * following links, then renamed into place, which replaces a link at
 * `path` rather than writing through it.
 */
export function writePrivate(path: string, text: string): void {
  const partial = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const fd = openSync(partial, CREATE, 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(partial, path);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
}

/**
 * `execFile`, as `util.promisify` makes it, with the child recorded (see
 * the contract above) and the recorder's variables carried into an
 * environment the caller gives it. Rejects as `execFile` does, with the
 * output on the error.
 */
export function execFileRecorded(
  file: string,
  args: readonly string[],
  options: ExecFileOptions = {}
): Promise<{ readonly stderr: string; readonly stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      {
        ...options,
        encoding: "utf8",
        ...(options.env
          ? { env: { ...options.env, ...spawnRecordEnvironment() } }
          : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stderr, stdout }));
        } else {
          resolve({ stderr, stdout });
        }
      }
    );
    recordChild(child);
  });
}
