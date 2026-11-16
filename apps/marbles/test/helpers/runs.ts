import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { compareStarts } from "@foundry/lib/process-identity";
import {
  notPrivate,
  SPAWN_OWNER_ENV,
  startedAt,
  writePrivate,
} from "~/process/spawned";
import {
  type Marker,
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
        removeRoot(root);
      }
    },
    records: runRecords(root),
    root,
  };
}

export async function sweepFinishedRuns(
  parent: string,
  limits?: StopLimits
): Promise<void> {
  const base = notPrivate(parent, "directory");
  if (base !== undefined) {
    console.warn(`marbles tests: not sweeping ${parent}: ${base}`);
    return;
  }
  const roots = readdirSync(parent)
    .filter((name) => name.startsWith(RUN_PREFIX))
    .map((name) => join(parent, name));
  for (const root of roots) {
    const problem =
      notPrivate(root, "directory") ??
      notPrivate(join(root, OWNER_FILE), "file");
    if (problem !== undefined) {
      if (!problem.includes("ENOENT")) {
        console.warn(`marbles tests: not sweeping ${root}: ${problem}`);
      }
      continue;
    }
    if (isOver(root) && (await clear(root, limits))) {
      removeRoot(root);
    }
  }
}

function isOver(root: string): boolean {
  const owner = readOwner(root);
  if (owner === undefined) {
    return false;
  }
  const started = startedAt(owner.pid);
  return (
    started === null ||
    (started !== undefined &&
      compareStarts(started, owner.started) === "different")
  );
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

async function clear(root: string, limits?: StopLimits): Promise<boolean> {
  const marker: Marker = { name: RUN_ENV, value: root };
  const problems: string[] = [];
  try {
    problems.push(...(await stopRecorded(runRecords(root), marker, limits)));
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

function removeRoot(root: string): void {
  try {
    rmSync(root, { force: true, maxRetries: 3, recursive: true });
  } catch (error) {
    console.warn(
      `marbles tests: could not remove the run's root ${root}: ${String(error)}`
    );
  }
}
