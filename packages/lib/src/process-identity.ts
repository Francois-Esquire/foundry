import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

export interface ProcessIdentity {
  readonly pid: number;
  readonly started: string | null;
}

export interface SeenProcess {
  readonly pgid: number;
  readonly started: string;
}

const PS_TIMEOUT_MS = 5000;
const PS_ENV = { ...process.env, LC_ALL: "C", TZ: "UTC" };
const SPACES = /\s+/g;
const DIGITS = /^\d+$/;
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(.+)$/;
const SEEN_MS = 1000;
const LINUX = "linux:";
const PS = "ps:";
const STAT_PGID = 5 - 3;
const STAT_START = 22 - 3;

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
  if (!Number.isInteger(pgid) || ticks === undefined || !DIGITS.test(ticks)) {
    return;
  }
  return { pgid, started: `${LINUX}${bootId.trim()}:${ticks}` };
}

export function psStart(lstart: string): string {
  return `${PS}${lstart.trim().replace(SPACES, " ")}`;
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
  const listed = spawnSync(
    "ps",
    ["-o", "pid=,pgid=,lstart=", "-p", pids.join(",")],
    { encoding: "utf8", env: PS_ENV, timeout: PS_TIMEOUT_MS }
  );
  if (listed.error !== undefined || (listed.status ?? 2) > 1) {
    return;
  }
  for (const line of listed.stdout.split("\n")) {
    const parsed = PS_LINE.exec(line);
    if (parsed) {
      seen.set(Number(parsed[1]), {
        pgid: Number(parsed[2]),
        started: psStart(parsed[3] ?? ""),
      });
    }
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
  const listed = spawnSync("ps", ["-A", "-o", "pid=,pgid=,lstart="], {
    encoding: "utf8",
    env: PS_ENV,
    maxBuffer: 64 * 1024 * 1024,
    timeout: PS_TIMEOUT_MS,
  });
  if (listed.error !== undefined || listed.status !== 0) {
    return;
  }
  const seen = new Map<number, SeenProcess>();
  for (const line of listed.stdout.split("\n")) {
    const parsed = PS_LINE.exec(line);
    if (parsed) {
      seen.set(Number(parsed[1]), {
        pgid: Number(parsed[2]),
        started: psStart(parsed[3] ?? ""),
      });
    }
  }
  return seen;
}

export function startedAt(pid: number): string | null | undefined {
  const seen = lookProcesses([pid]);
  if (seen === undefined) {
    return;
  }
  return seen.get(pid)?.started ?? null;
}

const SELF: ProcessIdentity = Object.freeze({
  pid: process.pid,
  started: startedAt(process.pid) ?? null,
});

export function thisProcess(): ProcessIdentity {
  return SELF;
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

export function isGone(owner: ProcessIdentity): boolean {
  if (owner.pid === SELF.pid) {
    return compareStarts(owner.started, SELF.started) === "different";
  }
  if (!processAlive(owner.pid)) {
    return true;
  }
  if (owner.started === null) {
    return false;
  }
  if (confirmedRecently(owner.pid, owner.started)) {
    return false;
  }
  const now = startedAt(owner.pid);
  remember(owner.pid, now);
  if (now === null) {
    return !processAlive(owner.pid);
  }
  return now !== undefined && compareStarts(now, owner.started) === "different";
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

function remember(pid: number, started: string | null | undefined): void {
  if (started === undefined || started === null) {
    recent.delete(pid);
  } else {
    recent.set(pid, { at: Date.now(), started });
  }
}
