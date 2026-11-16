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
  readonly group: boolean;
  readonly members?: readonly ProcessIdentity[];
  readonly owner?: ProcessIdentity;
  readonly pid: number;
  readonly started: string;
}

export const SPAWN_RECORD_ENV = "MARBLES_SPAWN_RECORD";
export const SPAWN_RECOVERY_ENV = "MARBLES_SPAWN_RECOVERY";
export const SPAWN_OWNER_ENV = "MARBLES_SPAWN_OWNER";

const CREATE =
  // biome-ignore lint/suspicious/noBitwiseOperators: open(2) takes its flags as one bit set.
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW |
  constants.O_WRONLY;

let reported = false;

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
  if (stats.mode % 0o100 !== 0) {
    return `${path} is open to group or others (mode ${(stats.mode % 0o1000).toString(8)})`;
  }
}

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
      rmSync(recordPath(recovery, pid), { force: true });
    });
  }
}

export interface GroupSystem {
  kill(target: number, signal: NodeJS.Signals | 0): void;
  sleep(ms: number): Promise<void>;
}

export interface RecordGroupOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly graceMs?: number;
  readonly killMs?: number;
  readonly signal?: AbortSignal;
  readonly system?: GroupSystem;
}

const GROUP_GRACE_MS = 2000;
const GROUP_KILL_MS = 1000;
const GROUP_POLL_MS = 50;

const GROUP_SYSTEM: GroupSystem = {
  kill: (target, signal) => process.kill(target, signal),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
};

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
  let stopping: Promise<boolean> | undefined;
  const stop = (): Promise<boolean> => {
    stopping ??= stopGroup(pid, system, {
      graceMs: options.graceMs ?? GROUP_GRACE_MS,
      killMs: options.killMs ?? GROUP_KILL_MS,
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
  child.once("exit", () => {
    stop().catch(() => false);
  });
  return stop;
}

async function stopGroup(
  pgid: number,
  system: GroupSystem,
  limits: { readonly graceMs: number; readonly killMs: number }
): Promise<boolean> {
  for (const [signal, ms] of [
    ["SIGTERM", limits.graceMs],
    ["SIGKILL", limits.killMs],
  ] as const) {
    if (!groupSignal(system, pgid, signal)) {
      return true;
    }
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      await system.sleep(GROUP_POLL_MS);
      if (!groupSignal(system, pgid, 0)) {
        return true;
      }
    }
  }
  return false;
}

function groupSignal(
  system: GroupSystem,
  pgid: number,
  signal: NodeJS.Signals | 0
): boolean {
  try {
    system.kill(-pgid, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

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

function privateDirectory(dir: string): void {
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const problem = notPrivate(dir, "directory");
  if (problem !== undefined) {
    throw new Error(problem);
  }
}

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
