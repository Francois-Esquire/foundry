import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { markedProcesses, stopProcesses } from "./processes";

/**
 * One test run: a root directory that holds everything the run makes, and
 * a marker, `MARBLES_TEST_RUN=<root>`, in the environment of every process
 * it starts. The root names its owner, the run's main process, by pid and
 * start time; the run is over once no process with that pid started then.
 * Anything short of that, a root with no owner or one that cannot be
 * read, or a process list that cannot be had, counts as live: its owner
 * may be starting, or be a suite that knows nothing of this.
 *
 * A Unix socket the owner listens on looked simpler and is not proof: a
 * connect is refused while the listener's queue is full, which a busy
 * owner lets happen.
 */
export interface Run {
  /** Stop what the run left running, then remove its root. */
  finish(): Promise<void>;
  readonly root: string;
}

export const RUN_ENV = "MARBLES_TEST_RUN";
export const RUN_PREFIX = "marbles-run-";
const OWNER_FILE = "owner.json";

interface Owner {
  readonly pid: number;
  /** As `ps -o lstart=` prints it. */
  readonly started: string;
}

/** Start a run under `parent`, owned by this process. */
export function startRun(parent: string): Run {
  const root = mkdtempSync(join(parent, RUN_PREFIX));
  const started = startTime(process.pid);
  if (started === undefined) {
    rmSync(root, { force: true, recursive: true });
    throw new Error("marbles tests: could not read this process's start time");
  }
  // Written whole or not at all, so a reader never finds half an owner.
  const partial = join(root, `${OWNER_FILE}.new`);
  writeFileSync(partial, JSON.stringify({ pid: process.pid, started }));
  renameSync(partial, join(root, OWNER_FILE));
  return {
    async finish() {
      // A root whose processes would not stop is kept; once this process
      // exits, the next run's sweep finds the run over and tries again.
      if (await stopMarked(root)) {
        removeRoot(root);
      }
    },
    root,
  };
}

/**
 * Clean up after every run under `parent` that is over: stop the
 * processes that carry its marker, then remove its root. A run that is
 * live, or cannot be shown over, is left alone.
 */
export async function sweepFinishedRuns(parent: string): Promise<void> {
  const roots = readdirSync(parent)
    .filter((name) => name.startsWith(RUN_PREFIX))
    .map((name) => join(parent, name));
  for (const root of roots) {
    if (isOver(root) && (await stopMarked(root))) {
      removeRoot(root);
    }
  }
}

function isOver(root: string): boolean {
  const owner = readOwner(root);
  if (owner === undefined) {
    return false;
  }
  const listed = spawnSync("ps", ["-o", "lstart=", "-p", String(owner.pid)], {
    encoding: "utf8",
  });
  if (listed.error !== undefined) {
    return false;
  }
  const started = listed.stdout.trim();
  // `ps` exits 1, printing nothing, when no process has the pid.
  return started === "" ? listed.status === 1 : started !== owner.started;
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

function startTime(pid: number): string | undefined {
  const listed = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
  });
  const started = listed.stdout?.trim();
  return listed.status === 0 && started ? started : undefined;
}

/** Whether every process carrying the run's marker is confirmed gone. */
async function stopMarked(root: string): Promise<boolean> {
  const survivors = await stopProcesses(markedProcesses(RUN_ENV, root));
  if (survivors.length > 0) {
    console.warn(
      `marbles tests: kept ${root}; its processes ${survivors.join(", ")} would not stop`
    );
  }
  return survivors.length === 0;
}

/**
 * Remove a run's root, and only it: recursive removal deletes a symbolic
 * link inside it, not what the link points to. A failure warns rather
 * than failing the run; the next run's sweep tries again.
 */
function removeRoot(root: string): void {
  try {
    rmSync(root, { maxRetries: 3, recursive: true });
  } catch (error) {
    console.warn(
      `marbles tests: could not remove the run's root ${root}: ${String(error)}`
    );
  }
}
