/**
 * Telling one process from any other given its pid since: by its pid and
 * when it started. A pid alone is not proof of anything after the process
 * that had it exited, and after a reboot the old pids are handed out
 * again from the start. Every owner Foundry records (who holds a lock, a
 * claim, a Run, a container row, a background child) is a
 * `ProcessIdentity`, and `isGone` is the one way to ask whether that
 * owner is still there.
 *
 * Node-bound: import it from main-process code only.
 */

import { spawnSync } from "node:child_process";

/**
 * One process: its pid, and when it started as `ps -o lstart=` prints it
 * in UTC. `started` is `null` when that could not be read, as for an owner
 * recorded before start times were kept; the pid alone then decides.
 */
export interface ProcessIdentity {
  readonly pid: number;
  readonly started: string | null;
}

/** How long `ps` gets to answer. */
const PS_TIMEOUT_MS = 5000;
/** `ps` prints a start time in its caller's zone and language: one for every caller. */
const PS_ENV = { ...process.env, LC_ALL: "C", TZ: "UTC" };
const SPACES = /\s+/g;
/** How long a start time read for a live pid is trusted. */
const SEEN_MS = 1000;

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
 * This process, read once, as the module loads: nothing that records this
 * process as an owner waits on `ps`, or fails when it cannot answer.
 */
const SELF: ProcessIdentity = Object.freeze({
  pid: process.pid,
  started: startedAt(process.pid) ?? null,
});

/** This process, as every record of an owner names it. */
export function thisProcess(): ProcessIdentity {
  return SELF;
}

/** Whether a process has the pid: `EPERM` counts, since then it belongs to another user. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether the process `owner` names is gone: no process has its pid, or
 * the one that has it now started at another time. When a start time
 * cannot be read, on either side, the pid alone decides, so a live owner
 * is never taken for gone.
 */
export function isGone(owner: ProcessIdentity): boolean {
  if (owner.pid === SELF.pid) {
    // A process before this one that had its pid, as after a reboot.
    return !sameStarted(owner.started, SELF.started);
  }
  if (!processAlive(owner.pid)) {
    return true;
  }
  if (owner.started === null) {
    return false;
  }
  const now = recentStart(owner.pid);
  return now === null || (now !== undefined && !sameStart(now, owner.started));
}

/** Whether `one` and `other` name the same process, as far as either says. */
export function sameProcess(
  one: ProcessIdentity,
  other: ProcessIdentity
): boolean {
  return one.pid === other.pid && sameStarted(one.started, other.started);
}

/** Two start times `ps` printed, however it spaced them. */
export function sameStart(one: string, other: string): boolean {
  return normal(one) === normal(other);
}

/** An owner identity from a row's two columns; `null` without a pid. */
export function ownerOf(
  pid: number | null,
  started: string | null
): ProcessIdentity | null {
  return pid === null ? null : { pid, started };
}

/** Whether `value` is a `ProcessIdentity`, as read back from JSON. */
export function isProcessIdentity(value: unknown): value is ProcessIdentity {
  const identity = value as Partial<ProcessIdentity> | null;
  return (
    typeof identity === "object" &&
    identity !== null &&
    Number.isInteger(identity.pid) &&
    (identity.pid ?? 0) > 0 &&
    (identity.started === null || typeof identity.started === "string")
  );
}

function sameStarted(one: string | null, other: string | null): boolean {
  return one === null || other === null || sameStart(one, other);
}

function normal(started: string): string {
  return started.trim().replace(SPACES, " ");
}

const seen = new Map<number, { at: number; started: string | null }>();

/** `startedAt`, trusted for a moment: a live pid's start time cannot change. */
function recentStart(pid: number): string | null | undefined {
  const known = seen.get(pid);
  if (known !== undefined && Date.now() - known.at < SEEN_MS) {
    return known.started;
  }
  const started = startedAt(pid);
  if (started === undefined) {
    seen.delete(pid);
  } else {
    seen.set(pid, { at: Date.now(), started });
  }
  return started;
}
