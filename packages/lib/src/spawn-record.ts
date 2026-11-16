import {
  type ChildProcess,
  type ExecFileOptions,
  execFile,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  linkSync,
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
  groupIdTaken,
  groupMembers,
  groupState,
  lookProcesses,
  type ProcessIdentity,
  type ProcessLookup,
  processAlive,
  type SeenProcess,
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
  env: Readonly<Record<string, string | undefined>> = process.env,
  lookup?: ProcessLookup
): void {
  recordInto(pid, group, env, lookup);
}

function recordInto(
  pid: number | undefined,
  group: boolean,
  env: Readonly<Record<string, string | undefined>>,
  lookup: ProcessLookup = RECORD_LOOKUP
): string | undefined {
  const all = named(env[SPAWN_RECORD_ENV]);
  const recovery = named(env[SPAWN_RECOVERY_ENV]);
  if ((all === undefined && recovery === undefined) || pid === undefined) {
    return;
  }
  try {
    return write(pid, group, all, recovery, lookup);
  } catch (error) {
    if (!reported) {
      reported = true;
      reportLine(
        `could not record process ${String(pid)} in ${[all, recovery].filter(Boolean).join(" and ")}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

export function recordChild(
  child: Pick<ChildProcess, "once" | "pid">,
  group = false,
  env: Readonly<Record<string, string | undefined>> = process.env
): void {
  const started = recordInto(child.pid, group, env);
  const recovery = named(env[SPAWN_RECOVERY_ENV]);
  const { pid } = child;
  if (recovery !== undefined && pid !== undefined && started !== undefined) {
    child.once("exit", () => {
      forgetRecord(recordPath(recovery, pid), { pid, started });
    });
  }
}

export interface GroupSystem {
  kill(target: number, signal: NodeJS.Signals | 0): void;
  members(pgid: number): ReadonlyMap<number, SeenProcess> | undefined;
  report?(line: string): void;
  sleep(ms: number): Promise<void>;
  write?(path: string, text: string): void;
}

export interface GroupStopResult {
  readonly emptied: boolean;
  readonly saved: boolean;
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

const RECORD_LOOKUP: ProcessLookup = {
  alive: (pid) => processAlive(pid),
  look: (pids) => lookProcesses(pids),
};

const GROUP_SYSTEM: GroupSystem = {
  kill: (target, signal) => process.kill(target, signal),
  members: groupMembers,
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
};

export function recordGroup(
  child: Pick<ChildProcess, "exitCode" | "once" | "pid" | "signalCode">,
  options: RecordGroupOptions = {}
): () => Promise<GroupStopResult> {
  const env = options.env ?? process.env;
  const { pid } = child;
  const started = recordInto(pid, true, env);
  if (pid === undefined) {
    return () => Promise.resolve({ emptied: true, saved: true });
  }
  const recovery = named(env[SPAWN_RECOVERY_ENV]);
  const system = options.system ?? GROUP_SYSTEM;
  const record = recovery === undefined ? undefined : recordPath(recovery, pid);
  let reaped = false;
  const held = (): boolean =>
    !reaped && child.exitCode === null && child.signalCode === null;
  let saved = true;
  let told = false;
  const save = (
    members: ReadonlyMap<number, SeenProcess> | undefined
  ): void => {
    if (record === undefined) {
      return;
    }
    if (members === undefined) {
      saved = false;
      return;
    }
    if (!saveMembers(pid, record, members, system)) {
      saved = false;
    }
  };
  let stopping: Promise<GroupStopResult> | undefined;
  const stop = (): Promise<GroupStopResult> => {
    stopping ??= stopGroup(pid, system, {
      graceMs: options.graceMs ?? GROUP_GRACE_MS,
      held,
      killMs: options.killMs ?? GROUP_KILL_MS,
      leader: { pid, started: started ?? null },
      save,
      unlisted: () => {
        if (!told) {
          told = true;
          (system.report ?? reportLine)(
            `the members of group ${String(pid)} could not be listed; ${held() ? "its own unreaped leader proves the group, so it is signalled without them, and they are not written down" : "its leader is reaped, so nothing proves the group still its: not signalled, its recovery record kept"}`
          );
        }
      },
    }).then((emptied) => {
      if (emptied && record !== undefined && started !== undefined) {
        forgetRecord(record, { pid, started });
      }
      return { emptied, saved };
    });
    return stopping;
  };
  options.signal?.addEventListener("abort", () => stop().catch(() => false), {
    once: true,
  });
  child.once("exit", () => {
    reaped = true;
    stop().catch(() => false);
  });
  return stop;
}

interface GroupStop {
  readonly graceMs: number;
  readonly held: () => boolean;
  readonly killMs: number;
  readonly leader: ProcessIdentity;
  readonly save: (
    members: ReadonlyMap<number, SeenProcess> | undefined
  ) => void;
  readonly unlisted: () => void;
}

async function stopGroup(
  pgid: number,
  system: GroupSystem,
  stop: GroupStop
): Promise<boolean> {
  if (!groupSignal(system, pgid, 0)) {
    return true;
  }
  const listed = system.members(pgid);
  let known = running(listed);
  const first = listing(listed, known, pgid, system, stop);
  if (first !== undefined) {
    return first;
  }
  if (known === undefined || known.size > 0) {
    stop.save(known);
  }
  for (const [signal, ms] of [
    ["SIGTERM", stop.graceMs],
    ["SIGKILL", stop.killMs],
  ] as const) {
    if (signal === "SIGKILL") {
      const proof = reproved(known, pgid, system, stop);
      if (typeof proof === "boolean") {
        return proof;
      }
      known = proof;
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

function reproved(
  known: ReadonlyMap<number, SeenProcess> | undefined,
  pgid: number,
  system: GroupSystem,
  stop: GroupStop
): boolean | ReadonlyMap<number, SeenProcess> | undefined {
  const listedNow = system.members(pgid);
  const now = running(listedNow);
  const settled = listing(listedNow, now, pgid, system, stop);
  if (settled !== undefined) {
    return settled;
  }
  if (!(stop.held() || (now !== undefined && provedIn(known, now)))) {
    return false;
  }
  if (now === undefined) {
    return known;
  }
  stop.save(now);
  return now;
}

async function emptiedWithin(
  system: GroupSystem,
  pgid: number,
  ms: number
): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!groupSignal(system, pgid, 0)) {
      return true;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await system.sleep(GROUP_POLL_MS);
  }
  return groupState(system.members(pgid), true) === "empty";
}

function listing(
  listed: ReadonlyMap<number, SeenProcess> | undefined,
  known: ReadonlyMap<number, SeenProcess> | undefined,
  pgid: number,
  system: GroupSystem,
  stop: GroupStop
): boolean | undefined {
  if (reused(known, pgid, stop)) {
    return true;
  }
  const state = groupState(listed, true);
  if (state === "empty") {
    return true;
  }
  if (listed === undefined) {
    stop.unlisted();
    return stop.held() ? undefined : false;
  }
  if (state === "unknown" && !stop.held()) {
    reportUntold(system, pgid);
    return false;
  }
}

function reportUntold(system: GroupSystem, pgid: number): void {
  (system.report ?? reportLine)(
    `group ${String(pgid)} is not listed but a signal still reaches it; not signalled, its recovery record kept for the next start`
  );
}

function reused(
  members: ReadonlyMap<number, SeenProcess> | undefined,
  pgid: number,
  stop: GroupStop
): boolean {
  return groupIdTaken(stop.leader, members?.get(pgid), !stop.held());
}

function running(
  members: ReadonlyMap<number, SeenProcess> | undefined
): ReadonlyMap<number, SeenProcess> | undefined {
  return members === undefined
    ? undefined
    : new Map([...members].filter(([, seen]) => seen.exited !== true));
}

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

function saveMembers(
  pgid: number,
  path: string,
  members: ReadonlyMap<number, SeenProcess>,
  system: GroupSystem
): boolean {
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
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
        .map(
          ([pid, seen]): ProcessIdentity => ({ pid, started: seen.started })
        );
      if (added.length > 0 || record.members === undefined) {
        (system.write ?? writePrivate)(
          path,
          JSON.stringify({ ...record, members: [...known, ...added] })
        );
      }
      return true;
    } catch (error) {
      failure = error;
    }
  }
  (system.report ?? reportLine)(
    `could not save the members of group ${String(pgid)} into its recovery record ${path}, so a start after this process died mid-stop could not prove them; stopping the group all the same: ${failure instanceof Error ? failure.message : String(failure)}`
  );
  return false;
}

function reportLine(line: string): void {
  process.stderr.write(`foundry: ${line}\n`);
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
  recovery: string | undefined,
  lookup: ProcessLookup
): string | undefined {
  for (const dir of [all, recovery]) {
    if (dir !== undefined) {
      privateDirectory(dir);
    }
  }
  const seen = lookup.look([pid]);
  if (seen === undefined) {
    throw new Error("ps could not say when it started");
  }
  const started = seen.get(pid)?.started;
  if (started === undefined) {
    if (lookup.alive(pid)) {
      throw new Error("it is not listed, yet a signal reaches it");
    }
    return;
  }
  const written = started;
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
  return written;
}

function privateDirectory(dir: string): void {
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const problem = notPrivate(dir, "directory");
  if (problem !== undefined) {
    throw new Error(problem);
  }
}

export interface RecordFiles {
  link(existing: string, path: string): void;
  read(path: string): string;
  remove(path: string): void;
  rename(from: string, to: string): void;
}

const RECORD_FILES: RecordFiles = {
  link: (existing, path) => linkSync(existing, path),
  read: (path) => readFileSync(path, "utf8"),
  remove: (path) => rmSync(path, { force: true }),
  rename: (from, to) => renameSync(from, to),
};

export function forgetRecord(
  path: string,
  identity: { readonly pid: number; readonly started: string },
  files: RecordFiles = RECORD_FILES
): void {
  const aside = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.forget.json`
  );
  try {
    files.rename(path, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
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
  if (
    moved?.pid === identity.pid &&
    typeof moved.started === "string" &&
    compareStarts(moved.started, identity.started) === "same"
  ) {
    files.remove(aside);
    return;
  }
  try {
    files.link(aside, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return;
    }
    throw error;
  }
  files.remove(aside);
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
