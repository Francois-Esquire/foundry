/**
 * Records of the processes Foundry starts in the background, for whoever
 * has to find them again after the process that started them is gone:
 * today the Marbles test suite, which stops exactly what its runs started.
 *
 * The contract:
 *
 * - Active only while `MARBLES_SPAWN_RECORD` names a directory in the
 *   environment the caller passes (by default this process's). Unset,
 *   `recordSpawned` returns at once and runs nothing.
 * - The directory must be private: a real directory (not a link), owned
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

import { type ExecFileOptions, execFile, spawnSync } from "node:child_process";
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

export interface SpawnRecord {
  /** It leads a process group of its own, whose id is its pid. */
  readonly group: boolean;
  readonly pid: number;
  /** As `startedAt` reads it. */
  readonly started: string;
}

/** The directory records go to. */
export const SPAWN_RECORD_ENV = "MARBLES_SPAWN_RECORD";
/**
 * An owner's mark, carried to every child, that a reader of the records
 * can check a process's environment for.
 */
export const SPAWN_OWNER_ENV = "MARBLES_SPAWN_OWNER";

/** How long `ps` gets to answer. */
const PS_TIMEOUT_MS = 5000;
/** `ps` prints a start time in its caller's zone and language: one for every caller. */
const PS_ENV = { ...process.env, LC_ALL: "C", TZ: "UTC" };
/** Create a new file, never an existing one, and never through a link. */
const CREATE =
  // biome-ignore lint/suspicious/noBitwiseOperators: open(2) takes its flags as one bit set.
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW |
  constants.O_WRONLY;

let reported = false;

/**
 * When the process `pid` started, as `ps -o lstart=` prints it in UTC;
 * `null` when no process has the pid, `undefined` when `ps` cannot tell.
 */
export function startedAt(pid: number): string | null | undefined {
  const listed = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: PS_ENV,
    timeout: PS_TIMEOUT_MS,
  });
  const started = listed.stdout?.trim();
  if (listed.status === 0 && started) {
    return started;
  }
  // `ps` exits 1, printing nothing, when no process has the pid.
  return listed.error === undefined && listed.status === 1 && !started
    ? null
    : undefined;
}

/**
 * The recorder's own variables in `env`, for a child started with an
 * environment of its own choosing, so what it starts is recorded and
 * marked too. Empty when recording is off.
 */
export function spawnRecordEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const carried: Record<string, string> = {};
  for (const name of [SPAWN_RECORD_ENV, SPAWN_OWNER_ENV]) {
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
 */
export function recordSpawned(
  pid: number | undefined,
  group: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env
): void {
  const dir = env[SPAWN_RECORD_ENV];
  if (dir === undefined || dir === "" || pid === undefined) {
    return;
  }
  try {
    write(dir, pid, group);
  } catch (error) {
    if (!reported) {
      reported = true;
      process.stderr.write(
        `foundry: could not record process ${String(pid)} in ${dir}: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }
}

function write(dir: string, pid: number, group: boolean): void {
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const problem = notPrivate(dir, "directory");
  if (problem !== undefined) {
    throw new Error(problem);
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
  writePrivate(join(dir, `${String(pid)}.json`), JSON.stringify(record));
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
    recordSpawned(child.pid, false);
  });
}
