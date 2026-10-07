import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { FileLockHolder } from "@foundry/lib/file-lock";
import { processAlive, tryFileLock } from "@foundry/lib/file-lock";

/**
 * `<dir>/locks/<name>` holds the pid of the process that has it, so a
 * launchd tick that lands while the previous one is still going skips rather
 * than doubles up, and two processes never adopt one parked run. It is the
 * `@foundry/lib/file-lock` protocol taken without waiting: a lock whose
 * holder has exited, or that stayed empty for 30s (its creator died before
 * writing its pid), is broken and taken over, one breaker at a time through
 * `<name>.break`. A file that is neither a pid nor empty is never broken.
 */

export interface Lock {
  /** Give the lock up, once; a lock someone else has taken since is left alone. */
  release(): void;
}

/** A lock someone else has; `holder` says who, for people: `pid 1234`, `this process`. */
export interface HeldLock {
  readonly holder: string;
}

/** The lock, or who holds it now. */
export function acquireLock(dir: string, name: string): Lock | HeldLock {
  mkdirSync(join(dir, "locks"), { recursive: true });
  const path = join(dir, "locks", name);
  const attempt = tryFileLock(path, { breakStale: true });
  return "release" in attempt
    ? attempt
    : { holder: describeHolder(path, attempt) };
}

function describeHolder(
  path: string,
  { empty, holder }: FileLockHolder
): string {
  if (empty) {
    return "a process that is taking it now; retry";
  }
  if (holder === undefined) {
    return `an unknown process (if none is running, remove ${path})`;
  }
  if (processAlive(holder)) {
    return `pid ${String(holder)}`;
  }
  // Only while another process has the turn to break it, or a crashed one
  // left that turn behind.
  return `pid ${String(holder)}, which has exited (if no process is taking the lock over, remove ${path}.break)`;
}

/** Schedule locks have their own namespace, separate from recovery and record edits. */
const SCHEDULE_PREFIX = "schedule:";

export function scheduleLockName(key: string): string {
  return `${SCHEDULE_PREFIX}${key}`;
}

export function scheduleKeyOfLock(name: string): string | undefined {
  return name.startsWith(SCHEDULE_PREFIX)
    ? name.slice(SCHEDULE_PREFIX.length)
    : undefined;
}
