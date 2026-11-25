export interface ProcessIdentity {
  readonly pid: number;
  readonly started: string | null;
}

export interface SeenProcess {
  readonly exited?: true;
  readonly pgid: number;
  readonly started: string;
}

export interface ProcessLookup {
  alive(pid: number): boolean;
  look(pids: readonly number[]): ReadonlyMap<number, SeenProcess> | undefined;
}

export type ProcessState = "gone" | "running" | "unknown";

const SPACES = /\s+/g;
const DIGITS = /^\d+$/;
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/;
const LSTART =
  /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) \d{4}$/;
const PS_STATE = /^[A-Z?][A-Za-z<>+]*$/;
const PROC_STATE = /^[A-Za-z]$/;
const BOOT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LINUX = "linux:";
const PS = "ps:";
const STAT_STATE = 3 - 3;
const STAT_PGID = 5 - 3;
const STAT_START = 22 - 3;
const UNLISTED = new Set(["EACCES", "ENOENT", "EPERM", "ESRCH"]);

function exitedState(state: string | undefined): boolean {
  return (
    state !== undefined && (state.startsWith("Z") || state.startsWith("X"))
  );
}

function errorCode(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "";
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
      if (UNLISTED.has(errorCode(error))) {
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

export function startedAt(
  pid: number,
  lookup: ProcessLookup
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

export function compareStarts(
  one: string | null,
  other: string | null
): "different" | "same" | "unknown" {
  if (one === null || other === null || kindOf(one) !== kindOf(other)) {
    return "unknown";
  }
  return normal(one) === normal(other) ? "same" : "different";
}

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

let portable: ProcessIdentity | undefined;

export function portableProcess(): ProcessIdentity {
  portable ??= Object.freeze({
    pid: 0,
    started: new Date().toISOString(),
  });
  return portable;
}

export function neverGone(_owner?: ProcessIdentity): boolean {
  return false;
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
