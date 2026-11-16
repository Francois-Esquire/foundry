import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

export interface ProcessIdentity {
  readonly pid: number;
  readonly started: string | null;
}

export interface SeenProcess {
  readonly exited?: true;
  readonly pgid: number;
  readonly started: string;
}

const PS_TIMEOUT_MS = 5000;
const PS_ENV = { ...process.env, LC_ALL: "C", TZ: "UTC" };
const SPACES = /\s+/g;
const DIGITS = /^\d+$/;
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/;
const LSTART =
  /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) \d{4}$/;
const PS_STATE = /^[A-Z?][A-Za-z<>+]*$/;
const PROC_STATE = /^[A-Za-z]$/;
const BOOT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PS_COLUMNS = "pid=,pgid=,state=,lstart=";
const SEEN_MS = 1000;
const LINUX = "linux:";
const PS = "ps:";
const STAT_STATE = 3 - 3;
const STAT_PGID = 5 - 3;
const STAT_START = 22 - 3;

function exitedState(state: string | undefined): boolean {
  return (
    state !== undefined && (state.startsWith("Z") || state.startsWith("X"))
  );
}

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

export function psStart(lstart: string): string {
  return `${PS}${normalStart(lstart)}`;
}

function normalStart(lstart: string): string {
  return lstart.trim().replace(SPACES, " ");
}

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
  const read = procListing(
    pids,
    (pid) => readFileSync(`/proc/${String(pid)}/stat`, "utf8"),
    boot
  );
  if (read === undefined) {
    return;
  }
  for (const [pid, entry] of read) {
    seen.set(pid, entry);
  }
  return seen;
}

const UNLISTED = new Set(["EACCES", "ENOENT", "EPERM", "ESRCH"]);

export function procListing(
  pids: readonly number[],
  read: (pid: number) => string,
  bootId: string
): Map<number, SeenProcess> | undefined {
  const seen = new Map<number, SeenProcess>();
  for (const pid of pids) {
    let stat: string;
    try {
      stat = read(pid);
    } catch (error) {
      if (UNLISTED.has((error as NodeJS.ErrnoException).code ?? "")) {
        continue;
      }
      return;
    }
    const found = procStat(stat, bootId);
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

export interface ProcessLookup {
  alive(pid: number): boolean;
  look(pids: readonly number[]): ReadonlyMap<number, SeenProcess> | undefined;
}

const LOOKUP: ProcessLookup = {
  alive: (pid) => processAlive(pid),
  look: (pids) => lookProcesses(pids),
};

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
    return lookup.alive(pid) ? undefined : null;
  }
  return found.exited === true ? null : found.started;
}

let self: ProcessIdentity = Object.freeze({
  pid: process.pid,
  started: startedAt(process.pid) ?? null,
});

export function thisProcess(): ProcessIdentity {
  if (self.started === null) {
    const started = startedAt(process.pid);
    if (typeof started === "string") {
      self = Object.freeze({ pid: process.pid, started });
    }
  }
  return self;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function compareStarts(
  one: string | null,
  other: string | null
): "different" | "same" | "unknown" {
  if (one === null || other === null || kindOf(one) !== kindOf(other)) {
    return "unknown";
  }
  return normal(one) === normal(other) ? "same" : "different";
}

export function processState(
  identity: ProcessIdentity,
  lookup: ProcessLookup = LOOKUP
): ProcessState {
  if (identity.pid === process.pid) {
    return compareStarts(identity.started, thisProcess().started) ===
      "different"
      ? "gone"
      : "running";
  }
  if (!lookup.alive(identity.pid)) {
    return "gone";
  }
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

export function groupState(
  listed: ReadonlyMap<number, SeenProcess> | undefined,
  reached: boolean
): "empty" | "running" | "unknown" {
  if (!reached) {
    return "empty";
  }
  if (listed === undefined) {
    return "unknown";
  }
  const members = [...listed.values()];
  if (members.some((seen) => seen.exited !== true)) {
    return "running";
  }
  return members.length > 0 ? "empty" : "unknown";
}

export function groupIdTaken(
  leader: ProcessIdentity,
  seen: SeenProcess | undefined,
  reaped = false
): boolean {
  if (seen === undefined || seen.exited === true) {
    return false;
  }
  return reaped || compareStarts(seen.started, leader.started) === "different";
}

export function isGone(
  owner: ProcessIdentity,
  lookup: ProcessLookup = LOOKUP
): boolean {
  return processState(owner, lookup) === "gone";
}

export function sameProcess(
  one: ProcessIdentity,
  other: ProcessIdentity
): boolean {
  return (
    one.pid === other.pid &&
    compareStarts(one.started, other.started) !== "different"
  );
}

export function ownerOf(
  pid: number | null,
  started: string | null
): ProcessIdentity | null {
  return pid === null ? null : { pid, started };
}

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
