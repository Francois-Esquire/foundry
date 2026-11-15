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

/**
 * One test run: a root directory that holds everything the run makes, the
 * records of every process it starts (under `spawned/`), and a marker,
 * `MARBLES_SPAWN_OWNER=<root>`, in the environment of each of them. The
 * root names its owner, the run's main process, by pid and start time;
 * the run is over once no process with that pid started then. Anything
 * short of that, a root with no owner or one that cannot be read, or a
 * process list that cannot be had, counts as live: its owner may be
 * starting, or be a suite that knows nothing of this.
 *
 * Roots live in one base directory, and nothing there is believed unless
 * it is private (`notPrivate`: a real directory or file, this user's, with
 * no permission for group or others): the base, each root, its owner, and
 * every directory and record below it, each checked as it is read. What is
 * not is skipped with a warning and never acted on, so a file someone else
 * could have written never decides what is signalled or removed.
 *
 * Ending a run, or sweeping one that is over, stops what its records
 * name (see `stopRecorded`), and removes its root only when every one is
 * confirmed gone and nothing carries its marker unrecorded. Otherwise the
 * root stays, with a warning, for the next sweep.
 */
export interface Run {
  /** Stop what the run left running, then remove its root. */
  finish(): Promise<void>;
  /** Where its processes are recorded: one directory per home, and the run's own. */
  readonly records: string;
  readonly root: string;
}

export const RUN_ENV = SPAWN_OWNER_ENV;
const RUN_PREFIX = "marbles-run-";
const OWNER_FILE = "owner.json";
const RECORDS = "spawned";
/** How long a process that carries the marker unrecorded gets to exit on its own. */
const UNRECORDED_MS = 2000;

interface Owner {
  readonly pid: number;
  /** As `startedAt` reads it. */
  readonly started: string;
}

/** Where the run rooted at `root` records its processes. */
export function runRecords(root: string): string {
  return join(root, RECORDS);
}

/**
 * The base directory runs keep their roots in, made private if it is
 * missing; throws if it is there and not private.
 */
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

/** Start a run in the private base `parent`, owned by this process. */
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
      // A root that cannot be cleared is kept; once this process exits,
      // the next run's sweep finds the run over and tries again.
      if (await clear(root, limits)) {
        removeRoot(root);
      }
    },
    records: runRecords(root),
    root,
  };
}

/**
 * Clean up after every run in the base `parent` that is over: stop what
 * its records name, then remove its root. A run that is live, cannot be
 * shown over, or is not private is left alone.
 */
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
      // A root that is being made, or one that is not this user's alone.
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

/** Whether the run's recorded processes are confirmed gone and nothing else carries its marker. */
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
    // A process list that cannot be had: nothing more is signalled here.
    problems.push(String(error));
  }
  if (problems.length > 0) {
    console.warn(`marbles tests: kept ${root}:\n  ${problems.join("\n  ")}`);
  }
  return problems.length === 0;
}

/** What `find` still finds once it has had a moment to empty. */
export async function outlast(find: () => number[]): Promise<number[]> {
  const deadline = Date.now() + UNRECORDED_MS;
  let found = find();
  while (found.length > 0 && Date.now() < deadline) {
    await sleep(100);
    found = find();
  }
  return found;
}

/**
 * Remove a run's root, and only it: recursive removal deletes a symbolic
 * link inside it, not what the link points to. A failure warns rather
 * than failing the run; the next run's sweep tries again.
 */
function removeRoot(root: string): void {
  try {
    // Forced: another run's sweep of the same root may be removing it too.
    rmSync(root, { force: true, maxRetries: 3, recursive: true });
  } catch (error) {
    console.warn(
      `marbles tests: could not remove the run's root ${root}: ${String(error)}`
    );
  }
}
