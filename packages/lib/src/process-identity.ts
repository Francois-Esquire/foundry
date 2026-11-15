/**
 * Telling one process from any other given its pid since: by its pid and
 * when it started. A pid alone is not proof of anything after the process
 * that had it exited, and after a reboot the old pids are handed out
 * again from the start. Every owner Foundry records (who holds a lock, a
 * claim, a Run, a container row, a background child) is a
 * `ProcessIdentity`, `isGone` is the one way to ask whether that owner is
 * still there, and `compareStarts` the one way to compare two of them.
 *
 * A start is an opaque string that names its kind, and two of different
 * kinds are never taken for the same process (nor for different ones):
 *
 * - `linux:<boot id>:<start ticks>`, from `/proc`: the clock ticks since
 *   boot at which the process started (`/proc/<pid>/stat`, field 22) and
 *   the boot's id (`/proc/sys/kernel/random/boot_id`). Neither moves with
 *   the wall clock, and the boot id tells one boot's pids from the next's.
 *   (`ps -o lstart` is unusable there: it adds the ticks to a boot time
 *   worked out from the wall clock, so a clock step moves every process.)
 * - `ps:<start>`, elsewhere (macOS), from `ps -o lstart` in UTC: the
 *   kernel keeps the time each process started, read once at its fork,
 *   and a later step of the clock does not rewrite it.
 *
 * Node-bound: import it from main-process code only.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

/**
 * One process: its pid, and its start (see above). `started` is `null`
 * when that could not be read; the pid alone then decides.
 */
export interface ProcessIdentity {
  readonly pid: number;
  readonly started: string | null;
}

/** What the system says about a process it lists. */
export interface SeenProcess {
  /**
   * It has exited and waits to be reaped (a zombie): it runs nothing, no
   * signal reaches it, and its pid is not free for another process yet.
   */
  readonly exited?: true;
  readonly pgid: number;
  readonly started: string;
}

/** How long `ps` gets to answer. */
const PS_TIMEOUT_MS = 5000;
/** `ps` prints a start time in its caller's zone and language: one for every caller. */
const PS_ENV = { ...process.env, LC_ALL: "C", TZ: "UTC" };
const SPACES = /\s+/g;
const DIGITS = /^\d+$/;
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/;
/** `ps -o lstart` in the C locale: `Sun Nov  5 08:00:00 2026`. */
const LSTART =
  /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) \d{4}$/;
/**
 * A process state as `ps` prints it: a letter, or `?` when it could not
 * read one (as while a process starts or exits), then its flags.
 */
const PS_STATE = /^[A-Z?][A-Za-z<>+]*$/;
/** A process state as `/proc/<pid>/stat` holds it: one letter. */
const PROC_STATE = /^[A-Za-z]$/;
/** `/proc/sys/kernel/random/boot_id`: a UUID. */
const BOOT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** What `ps` is asked for each process: `psLine` reads it back. */
const PS_COLUMNS = "pid=,pgid=,state=,lstart=";
/** How long a start read for a live pid is trusted. */
const SEEN_MS = 1000;
const LINUX = "linux:";
const PS = "ps:";
/** The fields of `/proc/<pid>/stat` after the command's closing parenthesis start at field 3. */
const STAT_STATE = 3 - 3;
const STAT_PGID = 5 - 3;
const STAT_START = 22 - 3;

/** A process state, from `/proc` or `ps`, that says it has exited (`Z`, or `X` as it goes). */
function exitedState(state: string | undefined): boolean {
  return (
    state !== undefined && (state.startsWith("Z") || state.startsWith("X"))
  );
}

/**
 * How `pid` runs now, from a `/proc/<pid>/stat` line and the boot id:
 * its group, its start, and whether it has exited. The command, field 2, is in parentheses and
 * may hold spaces and parentheses itself, so the fields after it are read
 * from its last closing parenthesis. `undefined` for a line that is not
 * one.
 */
export function procStat(
  stat: string,
  bootId: string
): SeenProcess | undefined {
  const end = stat.lastIndexOf(")");
  if (end === -1) {
    return;
  }
  const fields = stat
    .slice(end + 1)
    .trim()
    .split(" ");
  const pgid = Number(fields[STAT_PGID]);
  const ticks = fields[STAT_START];
  const boot = bootId.trim();
  if (
    !Number.isInteger(pgid) ||
    ticks === undefined ||
    !DIGITS.test(ticks) ||
    !PROC_STATE.test(fields[STAT_STATE] ?? "") ||
    !BOOT_ID.test(boot)
  ) {
    return;
  }
  return {
    ...(exitedState(fields[STAT_STATE]) ? { exited: true as const } : {}),
    pgid,
    started: `${LINUX}${boot}:${ticks}`,
  };
}

/**
 * One line `ps -o pid=,pgid=,state=,lstart=` printed: the pid, and how
 * it runs; `undefined` for a line that is not one, in exactly that shape:
 * a start cut short, a column out of place or one too many is not taken
 * for a start, since a start that is not one would read as another.
 */
export function psLine(
  line: string
): readonly [number, SeenProcess] | undefined {
  const parsed = PS_LINE.exec(line);
  if (
    parsed === null ||
    !PS_STATE.test(parsed[3] ?? "") ||
    !validStart(normalStart(parsed[4] ?? ""))
  ) {
    return;
  }
  return [
    Number(parsed[1]),
    {
      ...(exitedState(parsed[3]) ? { exited: true as const } : {}),
      pgid: Number(parsed[2]),
      started: psStart(parsed[4] ?? ""),
    },
  ];
}

/** A start `ps -o lstart` printed, as this module keeps it. */
export function psStart(lstart: string): string {
  return `${PS}${normalStart(lstart)}`;
}

function normalStart(lstart: string): string {
  return lstart.trim().replace(SPACES, " ");
}

/** Whether `lstart`, its spaces made single, is a start `ps` prints. */
function validStart(lstart: string): boolean {
  const parsed = LSTART.exec(lstart);
  if (parsed === null) {
    return false;
  }
  const [day, hours, minutes, seconds] = parsed.slice(1).map(Number);
  return (
    day !== undefined &&
    day >= 1 &&
    day <= 31 &&
    (hours ?? 24) < 24 &&
    (minutes ?? 60) < 60 &&
    (seconds ?? 61) < 61
  );
}

/**
 * What a `ps -o pid=,pgid=,state=,lstart=` listing says of each process
 * it lists; `undefined` when any line in it is not one (`psLine`), since
 * then it says nothing certain, of the processes it leaves out included.
 */
export function psListing(
  listed: string
): Map<number, SeenProcess> | undefined {
  const seen = new Map<number, SeenProcess>();
  for (const line of listed.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const parsed = psLine(line);
    if (parsed === undefined) {
      return;
    }
    seen.set(...parsed);
  }
  return seen;
}

let knownBoot: string | undefined;

function linuxBootId(): string {
  knownBoot ??= readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  return knownBoot;
}

/**
 * How each of `pids` that is running runs now: its group and its start;
 * `undefined` when the system cannot say.
 */
export function lookProcesses(
  pids: readonly number[]
): ReadonlyMap<number, SeenProcess> | undefined {
  const seen = new Map<number, SeenProcess>();
  if (pids.length === 0) {
    return seen;
  }
  return process.platform === "linux"
    ? lookProc(pids, seen)
    : lookPs(pids, seen);
}

function lookProc(
  pids: readonly number[],
  seen: Map<number, SeenProcess>
): ReadonlyMap<number, SeenProcess> | undefined {
  let boot: string;
  try {
    boot = linuxBootId();
  } catch {
    return;
  }
  for (const pid of pids) {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      return;
    }
    const found = procStat(stat, boot);
    if (found === undefined) {
      return;
    }
    seen.set(pid, found);
  }
  return seen;
}

function lookPs(
  pids: readonly number[],
  seen: Map<number, SeenProcess>
): ReadonlyMap<number, SeenProcess> | undefined {
  const listed = spawnSync("ps", ["-o", PS_COLUMNS, "-p", pids.join(",")], {
    encoding: "utf8",
    env: PS_ENV,
    timeout: PS_TIMEOUT_MS,
  });
  // `ps` exits 1 when one of the pids has no process, and lists the rest.
  if (listed.error !== undefined || (listed.status ?? 2) > 1) {
    return;
  }
  const read = psListing(listed.stdout);
  if (read === undefined) {
    return;
  }
  for (const [pid, entry] of read) {
    seen.set(pid, entry);
  }
  return seen;
}

/**
 * Every running process in the group `pgid`, with how each runs now;
 * `undefined` when the system cannot say.
 */
export function groupMembers(
  pgid: number
): ReadonlyMap<number, SeenProcess> | undefined {
  const all = process.platform === "linux" ? allProc() : allPs();
  if (all === undefined) {
    return;
  }
  return new Map([...all].filter(([, seen]) => seen.pgid === pgid));
}

function allProc(): ReadonlyMap<number, SeenProcess> | undefined {
  let pids: number[];
  try {
    pids = readdirSync("/proc")
      .filter((name) => DIGITS.test(name))
      .map(Number);
  } catch {
    return;
  }
  return lookProc(pids, new Map());
}

function allPs(): ReadonlyMap<number, SeenProcess> | undefined {
  const listed = spawnSync("ps", ["-A", "-o", PS_COLUMNS], {
    encoding: "utf8",
    env: PS_ENV,
    maxBuffer: 64 * 1024 * 1024,
    timeout: PS_TIMEOUT_MS,
  });
  if (listed.error !== undefined || listed.status !== 0) {
    return;
  }
  return psListing(listed.stdout);
}

/** How a process's identity is read from the system; a test replaces it. */
export interface ProcessLookup {
  /** Whether a signal reaches the pid (`processAlive`). */
  alive(pid: number): boolean;
  /** What the system says of each of `pids` it lists (`lookProcesses`). */
  look(pids: readonly number[]): ReadonlyMap<number, SeenProcess> | undefined;
}

const LOOKUP: ProcessLookup = {
  alive: (pid) => processAlive(pid),
  look: (pids) => lookProcesses(pids),
};

/**
 * The start of the process `pid` (see above); `null` when no process has
 * the pid (none is listed, and no signal reaches it), or the one that has
 * it has exited and waits to be reaped (a zombie), which runs nothing;
 * `undefined` when the system cannot say, as when the listing leaves out
 * a pid a signal still reaches.
 */
export function startedAt(
  pid: number,
  lookup: ProcessLookup = LOOKUP
): string | null | undefined {
  const seen = lookup.look([pid]);
  if (seen === undefined) {
    return;
  }
  const found = seen.get(pid);
  if (found === undefined) {
    // Absence from a listing is no proof while a signal still reaches it.
    return lookup.alive(pid) ? undefined : null;
  }
  return found.exited === true ? null : found.started;
}

/**
 * This process, read once, as the module loads: nothing that records this
 * process as an owner waits on the system, or fails when it cannot answer.
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
 * Two starts: `same` or `different` when both are of one kind, and
 * `unknown` when either is missing or they are of different kinds, which
 * says nothing either way.
 */
export function compareStarts(
  one: string | null,
  other: string | null
): "different" | "same" | "unknown" {
  if (one === null || other === null || kindOf(one) !== kindOf(other)) {
    return "unknown";
  }
  return normal(one) === normal(other) ? "same" : "different";
}

/**
 * What can be said of the process `identity` names now, by the one rule
 * for every pid Foundry reasons about (an owner, a recorded child, a
 * group's leader or member):
 *
 * - `gone`, only on positive evidence: no signal reaches its pid; or the
 *   process with it is listed as exited and waiting to be reaped (a
 *   zombie: a signal still reaches it, but it runs nothing); or it is
 *   listed with a start of the same kind that differs.
 * - `running`: listed, not exited, with the same start.
 * - `unknown`, for anything else: the listing failed; or it leaves the pid
 *   out while a signal still reaches it (absence from a listing is no
 *   proof); or the starts cannot be compared (another kind, or none).
 */
export function processState(
  identity: ProcessIdentity,
  lookup: ProcessLookup = LOOKUP
): ProcessState {
  if (identity.pid === SELF.pid) {
    // A process before this one that had its pid, as after a reboot.
    return compareStarts(identity.started, SELF.started) === "different"
      ? "gone"
      : "running";
  }
  if (!lookup.alive(identity.pid)) {
    return "gone";
  }
  // A start read a moment ago may only confirm the process: anything else
  // is decided on a fresh read, since the pid may be another's by now.
  // Only this system's own reads are kept, and only they confirm: what a
  // lookup a caller hands in says is never taken for what the system said.
  const cached = lookup === LOOKUP;
  if (
    cached &&
    identity.started !== null &&
    confirmedRecently(identity.pid, identity.started)
  ) {
    return "running";
  }
  const remember = cached ? rememberSeen : () => undefined;
  const seen = lookup.look([identity.pid]);
  if (seen === undefined) {
    remember(identity.pid, undefined);
    return "unknown";
  }
  const found = seen.get(identity.pid);
  if (found?.exited === true) {
    remember(identity.pid, null);
    return "gone";
  }
  if (found === undefined) {
    remember(identity.pid, null);
    // Listed as no process, yet a signal reached it a moment ago: the
    // listing is not trusted over the signal.
    return lookup.alive(identity.pid) ? "unknown" : "gone";
  }
  remember(identity.pid, found.started);
  const start = compareStarts(found.started, identity.started);
  if (start === "same") {
    return "running";
  }
  return start === "different" ? "gone" : "unknown";
}

export type ProcessState = "gone" | "running" | "unknown";

/**
 * Whether the process `owner` names is gone, by `processState`'s rule:
 * never on absence from a listing while a signal still reaches its pid,
 * nor when the starts cannot be compared, so a live owner is never taken
 * for gone.
 */
export function isGone(
  owner: ProcessIdentity,
  lookup: ProcessLookup = LOOKUP
): boolean {
  return processState(owner, lookup) === "gone";
}

/** Whether `one` and `other` name the same process, as far as either says. */
export function sameProcess(
  one: ProcessIdentity,
  other: ProcessIdentity
): boolean {
  return (
    one.pid === other.pid &&
    compareStarts(one.started, other.started) !== "different"
  );
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

/** A start's kind; one written before starts named theirs is a kind of its own. */
function kindOf(started: string): string {
  if (started.startsWith(LINUX)) {
    return LINUX;
  }
  return started.startsWith(PS) ? PS : "";
}

function normal(started: string): string {
  return started.trim().replace(SPACES, " ");
}

const recent = new Map<number, { at: number; started: string }>();

/**
 * Whether `pid` was read a moment ago as started at `started`: only ever
 * evidence that it is still that process, never that it is not.
 */
function confirmedRecently(pid: number, started: string): boolean {
  const known = recent.get(pid);
  return (
    known !== undefined &&
    Date.now() - known.at < SEEN_MS &&
    known.started !== null &&
    compareStarts(known.started, started) === "same"
  );
}

function rememberSeen(pid: number, started: string | null | undefined): void {
  if (started === undefined || started === null) {
    recent.delete(pid);
  } else {
    recent.set(pid, { at: Date.now(), started });
  }
}
