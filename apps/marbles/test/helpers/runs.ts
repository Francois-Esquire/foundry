import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isGone, type ProcessLookup } from "@foundry/lib/process-identity";
import {
  notPrivate,
  SPAWN_OWNER_ENV,
  startedAt,
  writePrivate,
} from "~/process/spawned";
import {
  type Marker,
  type ProcessSystem,
  type StopLimits,
  stopRecorded,
  unrecordedMarked,
} from "./processes";

export interface Run {
  finish(): Promise<void>;
  readonly records: string;
  readonly root: string;
}

export const RUN_ENV = SPAWN_OWNER_ENV;
const RUN_PREFIX = "marbles-run-";
const OWNER_FILE = "owner.json";
const MOVED_FILE = "moved-from.json";
const RECORDS = "spawned";
const UNRECORDED_MS = 2000;

interface Owner {
  readonly pid: number;
  readonly started: string;
}

export function runRecords(root: string): string {
  return join(root, RECORDS);
}

export function privateBase(base: string): string {
  try {
    mkdirSync(base, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  const problem = notPrivate(base, "directory");
  if (problem !== undefined) {
    throw new Error(`marbles tests: will not keep runs in ${base}: ${problem}`);
  }
  return base;
}

export function startRun(parent: string, limits?: StopLimits): Run {
  privateBase(parent);
  const root = mkdtempSync(join(parent, RUN_PREFIX));
  const started = startedAt(process.pid);
  if (typeof started !== "string") {
    rmSync(root, { force: true, recursive: true });
    throw new Error("marbles tests: could not read this process's start time");
  }
  writePrivate(
    join(root, OWNER_FILE),
    JSON.stringify({ pid: process.pid, started })
  );
  return {
    async finish() {
      if (await clear(root, limits)) {
        warnKept(
          await removeRoot(root, limits === undefined ? {} : { limits })
        );
      }
    },
    records: runRecords(root),
    root,
  };
}

export async function sweepFinishedRuns(
  parent: string,
  limits?: StopLimits,
  system?: ProcessSystem
): Promise<void> {
  const base = notPrivate(parent, "directory");
  if (base !== undefined) {
    console.warn(`marbles tests: not sweeping ${parent}: ${base}`);
    return;
  }
  const roots = readdirSync(parent)
    .filter((name) => name.startsWith(RUN_PREFIX))
    .map((name) => join(parent, name));
  const removal: RootRemoval = {
    ...(limits === undefined ? {} : { limits }),
    ...(system === undefined ? {} : { system }),
  };
  for (const root of roots) {
    if (sweepable(root) && (await clear(root, limits, system))) {
      warnKept(await removeRoot(root, removal));
    }
  }
}

export function runIsOver(root: string, lookup?: ProcessLookup): boolean {
  const owner = readOwner(root);
  return owner !== undefined && isGone(owner, lookup);
}

function sweepable(root: string): boolean {
  const problem = notPrivate(root, "directory");
  if (problem !== undefined) {
    if (!problem.includes("ENOENT")) {
      console.warn(`marbles tests: not sweeping ${root}: ${problem}`);
    }
    return false;
  }
  const owner = notPrivate(join(root, OWNER_FILE), "file");
  if (owner === undefined) {
    return runIsOver(root);
  }
  if (!owner.includes("ENOENT")) {
    console.warn(`marbles tests: not sweeping ${root}: ${owner}`);
    return false;
  }
  if (!holdsRecords(root)) {
    return false;
  }
  console.warn(
    `marbles tests: ${root} holds records and names no owner; its records are handled as any run's`
  );
  return true;
}

function holdsRecords(root: string): boolean {
  try {
    return readdirSync(runRecords(root)).length > 0;
  } catch {
    return false;
  }
}

function readOwner(root: string): Owner | undefined {
  try {
    const owner = JSON.parse(readFileSync(join(root, OWNER_FILE), "utf8"));
    return Number.isInteger(owner?.pid) && typeof owner?.started === "string"
      ? { pid: owner.pid, started: owner.started }
      : undefined;
  } catch {
    return undefined;
  }
}

async function clear(
  root: string,
  limits?: StopLimits,
  system?: ProcessSystem
): Promise<boolean> {
  const marker: Marker = { name: RUN_ENV, value: movedFrom(root) };
  const problems: string[] = [];
  try {
    problems.push(
      ...(await stopRecorded(runRecords(root), marker, limits, system))
    );
    const unrecorded = await outlast(() =>
      unrecordedMarked(runRecords(root), marker)
    );
    for (const pid of unrecorded) {
      problems.push(
        `process ${String(pid)} carries ${RUN_ENV}=${root} but was never recorded; not signalled`
      );
    }
  } catch (error) {
    problems.push(String(error));
  }
  if (problems.length > 0) {
    console.warn(`marbles tests: kept ${root}:\n  ${problems.join("\n  ")}`);
  }
  return problems.length === 0;
}

export async function outlast(find: () => number[]): Promise<number[]> {
  const deadline = Date.now() + UNRECORDED_MS;
  let found = find();
  while (found.length > 0 && Date.now() < deadline) {
    await sleep(100);
    found = find();
  }
  return found;
}

export interface RootFiles {
  remove(path: string): void;
  rename(from: string, to: string): void;
}

const ROOT_FILES: RootFiles = {
  remove: (path) =>
    rmSync(path, { force: true, maxRetries: 3, recursive: true }),
  rename: (from, to) => renameSync(from, to),
};

export interface RootRemoval {
  readonly files?: RootFiles;
  readonly limits?: StopLimits;
  readonly system?: ProcessSystem;
}

export async function removeRoot(
  root: string,
  options: RootRemoval = {}
): Promise<string[]> {
  const files = options.files ?? ROOT_FILES;
  const owner = readOwner(root);
  const ran = movedFrom(root);
  const aside = join(dirname(root), `${RUN_PREFIX}removing-${randomUUID()}`);
  const kept: string[] = [];
  try {
    if (!existsSync(join(root, MOVED_FILE))) {
      writePrivate(join(root, MOVED_FILE), JSON.stringify({ root: ran }));
    }
    files.rename(root, aside);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? []
      : [`could not move ${root} aside to remove it: ${String(error)}`];
  }
  try {
    const left = await stopRecorded(
      runRecords(aside),
      { name: RUN_ENV, value: ran },
      options.limits,
      options.system
    );
    if (left.length > 0) {
      kept.push(`kept ${aside}, moved from ${root}:`, ...left);
    } else {
      files.remove(aside);
    }
  } catch (error) {
    kept.push(`kept ${aside}, moved from ${root}: ${String(error)}`);
  } finally {
    if (existsSync(root)) {
      restoreOwner(root, owner);
      kept.push(
        `${root} was made again after it was moved aside, by a process that recorded itself there; kept for the next sweep`
      );
    }
  }
  return kept;
}

function restoreOwner(root: string, owner: Owner | undefined): void {
  if (owner === undefined || existsSync(join(root, OWNER_FILE))) {
    return;
  }
  try {
    writePrivate(join(root, OWNER_FILE), JSON.stringify(owner));
  } catch {
    // Its records still keep it in every sweep's view (see the sweep).
  }
}

function movedFrom(root: string): string {
  try {
    const moved = JSON.parse(readFileSync(join(root, MOVED_FILE), "utf8"));
    return typeof moved?.root === "string" ? moved.root : root;
  } catch {
    return root;
  }
}

function warnKept(kept: readonly string[]): void {
  if (kept.length > 0) {
    console.warn(`marbles tests: ${kept.join("\n  ")}`);
  }
}
