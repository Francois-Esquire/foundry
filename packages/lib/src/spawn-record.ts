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
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type ProcessIdentity,
  startedAt,
  thisProcess,
} from "./process-identity";

export interface SpawnRecord {
  /** It leads a process group of its own, whose id is its pid. */
  readonly group: boolean;
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
