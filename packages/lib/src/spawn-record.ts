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
  readonly group: boolean;
  readonly pid: number;
  readonly started: string;
}

export const SPAWN_RECORD_ENV = "MARBLES_SPAWN_RECORD";
export const SPAWN_OWNER_ENV = "MARBLES_SPAWN_OWNER";

const PS_TIMEOUT_MS = 5000;
const PS_ENV = { ...process.env, LC_ALL: "C", TZ: "UTC" };
const CREATE =
  // biome-ignore lint/suspicious/noBitwiseOperators: open(2) takes its flags as one bit set.
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW |
  constants.O_WRONLY;

let reported = false;

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
  return listed.error === undefined && listed.status === 1 && !started
    ? null
    : undefined;
}

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
    return;
  }
  if (started === undefined) {
    throw new Error("ps could not say when it started");
  }
  const record: SpawnRecord = { group, pid, started };
  writePrivate(join(dir, `${String(pid)}.json`), JSON.stringify(record));
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
    recordSpawned(child.pid, false);
  });
}
