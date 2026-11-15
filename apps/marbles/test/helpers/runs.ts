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
/** In a root moved aside to be removed: the root it was, which its processes carry. */
const MOVED_FILE = "moved-from.json";
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
        warnKept(
          await removeRoot(root, limits === undefined ? {} : { limits })
        );
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
      warnKept(await removeRoot(root, limits === undefined ? {} : { limits }));
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
    started === null || (started !== undefined && started !== owner.started)
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
  // The run's processes carry the root it had, which a root moved aside
  // to be removed names.
  const marker: Marker = { name: RUN_ENV, value: movedFrom(root) };
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

/** The file operations `removeRoot` makes; a test replaces them to land a write between two. */
export interface RootFiles {
  /** Remove a directory and all in it; a symbolic link inside goes, not what it points to. */
  remove(path: string): void;
  rename(from: string, to: string): void;
}

const ROOT_FILES: RootFiles = {
  // Forced: another run's sweep of the same root may be removing it too.
  remove: (path) =>
    rmSync(path, { force: true, maxRetries: 3, recursive: true }),
  rename: (from, to) => renameSync(from, to),
};

export interface RootRemoval {
  readonly files?: RootFiles;
  readonly limits?: StopLimits;
  readonly system?: ProcessSystem;
}

/**
 * Remove a run's root, which its stop found clear: what kept it, empty
 * once it is gone. A process may still record itself there at any
 * moment, so nothing seen before decides. The root is first moved aside
 * under a fresh name beside it (one rename, atomic): from then on,
 * nothing reaches what is about to be removed by the root's path. What
 * was moved is looked in then, and its records stopped as any run's are
 * (`stopRecorded`); it is removed only once that leaves none. Kept, it is
 * a run root still, which names the run it was (`moved-from.json`), so
 * the next sweep stops what it records.
 *
 * A writer reaches its record's directory by path each time (it holds
 * none open), so one that comes after the move makes the old root again
 * (`mkdir -p`) and records itself there: that root then lacks an owner,
 * and is given the run's, so the next sweep finds it, and it is reported.
 * One that opened its partial record before the move and renames it into
 * place after fails to (its path is gone) and says so on stderr; the
 * partial it leaves keeps the moved root, reported as still being
 * written, until it is stale.
 */
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
  const left = await stopRecorded(
    runRecords(aside),
    { name: RUN_ENV, value: ran },
    options.limits,
    options.system
  );
  if (left.length > 0) {
    kept.push(`kept ${aside}, moved from ${root}:`, ...left);
  } else {
    try {
      files.remove(aside);
    } catch (error) {
      kept.push(`could not remove ${aside}: ${String(error)}`);
    }
  }
  if (existsSync(root)) {
    // Made again by a process that recorded itself after the move.
    if (owner !== undefined && !existsSync(join(root, OWNER_FILE))) {
      writePrivate(join(root, OWNER_FILE), JSON.stringify(owner));
    }
    kept.push(
      `${root} was made again after it was moved aside, by a process that recorded itself there; kept for the next sweep`
    );
  }
  return kept;
}

/** The root of the run `root` was: itself, unless it was moved aside to be removed. */
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
