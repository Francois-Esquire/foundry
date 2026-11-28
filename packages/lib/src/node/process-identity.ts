import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

import {
  compareStarts,
  type OwnerLiveness,
  type ProcessIdentity,
  type ProcessLookup,
  type ProcessState,
  procListing,
  psListing,
  startedAt as pureStartedAt,
  type SeenProcess,
} from "../process-identity";

export type {
  OwnerLiveness,
  PortableProcessOptions,
  ProcessIdentity,
  ProcessLookup,
  ProcessState,
  SeenProcess,
} from "../process-identity";
// biome-ignore lint/performance/noBarrelFile: Declared Node adapter entry point re-exporting pure process-identity helpers alongside OS adapters.
export {
  compareStarts,
  createPortableProcess,
  groupIdTaken,
  groupState,
  isProcessIdentity,
  ownerOf,
  ownerStateOf,
  PORTABLE_OWNER_LIVENESS,
  procListing,
  procStat,
  psLine,
  psListing,
  psStart,
  sameProcess,
} from "../process-identity";

const PS_TIMEOUT_MS = 5000;
const DIGITS = /^\d+$/;
const PS_COLUMNS = "pid=,pgid=,state=,lstart=";
const SEEN_MS = 1000;

function psEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: "C", TZ: "UTC" };
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

function lookPs(
  pids: readonly number[],
  seen: Map<number, SeenProcess>
): ReadonlyMap<number, SeenProcess> | undefined {
  const listed = spawnSync("ps", ["-o", PS_COLUMNS, "-p", pids.join(",")], {
    encoding: "utf8",
    env: psEnv(),
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
    env: psEnv(),
    maxBuffer: 64 * 1024 * 1024,
    timeout: PS_TIMEOUT_MS,
  });
  if (listed.error !== undefined || listed.status !== 0) {
    return;
  }
  return psListing(listed.stdout);
}

const LOOKUP: ProcessLookup = {
  alive: (pid) => processAlive(pid),
  look: (pids) => lookProcesses(pids),
};

export function nodeStartedAt(
  pid: number,
  lookup: ProcessLookup = LOOKUP
): string | null | undefined {
  return pureStartedAt(pid, lookup);
}

let self: ProcessIdentity | undefined;

export function thisProcess(): ProcessIdentity {
  if (self === undefined || self.started === null) {
    const started = nodeStartedAt(process.pid);
    if (self === undefined) {
      self = Object.freeze({
        pid: process.pid,
        started: typeof started === "string" ? started : null,
      });
    } else if (typeof started === "string") {
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

export function isGone(
  owner: ProcessIdentity,
  lookup: ProcessLookup = LOOKUP
): boolean {
  return processState(owner, lookup) === "gone";
}

export const NODE_OWNER_LIVENESS: OwnerLiveness = {
  identity: thisProcess,
  isGone,
  stateOf: processState,
};

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
