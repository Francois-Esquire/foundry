import { rmSync } from "node:fs";
import { join } from "node:path";

import { lockHolder, processAlive } from "@foundry/lib/file-lock";

import { isRecord, readJson, writeJson } from "~/lib/state/json";
import { acquireLock } from "~/lib/state/locks";

/**
 * One Marbles process per machine, and one worker per workspace under it.
 * The process claims `locks/process` at the state root and describes
 * itself in `process.json` beside it: its pid, the socket it answers on,
 * and where it keeps things. Each worker claims the same pair under its
 * workspace's state dir. A second claimant is told who has it and does not
 * start. The lock is the claim: it holds the owner's pid, and one left by a
 * process that has exited is taken over (the `@foundry/lib/file-lock`
 * protocol, through `acquireLock`). The json is what `status` and clients
 * read; a crash can leave it behind, so nothing decides liveness from it.
 */

const LOCK = "process";
const FILE = "process.json";

export type ProcessHost = "daemon" | "worker";

/** What the owning process records about itself. */
export interface ProcessInfo {
  /** Where the daemon keeps the artifact store. */
  readonly artifacts?: string;
  /** The authoring source a worker loaded; null without one. */
  readonly config?: string | null;
  readonly host: ProcessHost;
  readonly pid: number;
  /** The Unix socket the daemon answers on. */
  readonly socket?: string;
  readonly startedAt: string;
  /** The Marbles version the daemon runs. */
  readonly version?: string;
}

/** The claim this process holds; `release` runs once. */
export interface ProcessInstance extends ProcessInfo {
  release(): void;
}

/** What `status` reads: the claim as the files describe it right now. */
export interface ProcessStatus {
  /** The lock names a pid, and that pid is running. */
  readonly alive: boolean;
  readonly artifacts: string | null;
  readonly config: string | null;
  readonly host: ProcessHost | null;
  /** The lock's holder, else what `process.json` last recorded. */
  readonly pid: number | null;
  readonly socket: string | null;
  readonly startedAt: string | null;
  readonly version: string | null;
}

/** Another process owns this state dir; `holder` says who, for people. */
export class ProcessHeldError extends Error {
  override readonly name = "ProcessHeldError";
  readonly holder: string;

  constructor(dir: string, holder: string, info: ProcessStatus | undefined) {
    const since =
      info?.alive && info.startedAt !== null ? ` since ${info.startedAt}` : "";
    const host = info?.alive && info.host !== null ? ` (${info.host})` : "";
    super(
      `a Marbles process already runs here: ${holder}${host}${since}. Stop it first, or point --state elsewhere (state: ${dir}).`
    );
    this.holder = holder;
  }
}

/**
 * Claim `dir` for this process, or throw `ProcessHeldError` naming who has
 * it. A worker calls it before its engine starts: starting is what adopts
 * parked runs. The daemon calls it before it listens.
 */
export function claimProcess(
  dir: string,
  info: Omit<ProcessInfo, "pid" | "startedAt">
): ProcessInstance {
  const lock = acquireLock(dir, LOCK);
  if ("holder" in lock) {
    throw new ProcessHeldError(dir, lock.holder, readProcess(dir));
  }
  const recorded: ProcessInfo = {
    ...info,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const path = join(dir, FILE);
  try {
    writeJson(path, { ...recorded, marbles: info.version, version: 1 });
  } catch (error) {
    lock.release();
    throw error;
  }
  let released = false;
  return {
    ...recorded,
    release() {
      if (released) {
        return;
      }
      released = true;
      // Only while the json still names this process: a late release must
      // not remove what a process that took the claim over has written.
      if (readInfo(path)?.pid === process.pid) {
        rmSync(path, { force: true });
      }
      lock.release();
    },
  };
}

/** The claim on `dir`, as the files describe it; `undefined` when nothing is recorded. */
export function readProcess(dir: string): ProcessStatus | undefined {
  const holder = lockHolder(join(dir, "locks", LOCK));
  const info = readInfo(join(dir, FILE));
  if (holder === undefined && info === undefined) {
    return undefined;
  }
  const alive = holder !== undefined && processAlive(holder);
  // Metadata is the holder's only while it describes the holder.
  const described =
    info !== undefined && (holder === undefined || info.pid === holder);
  const field = <K extends keyof ProcessInfo>(
    key: K
  ): NonNullable<ProcessInfo[K]> | null =>
    described ? (info[key] ?? null) : null;
  return {
    alive,
    artifacts: field("artifacts"),
    config: field("config"),
    host: field("host"),
    pid: holder ?? info?.pid ?? null,
    socket: field("socket"),
    startedAt: field("startedAt"),
    version: field("version"),
  };
}

function isHost(value: unknown): value is ProcessHost {
  return value === "daemon" || value === "worker";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readInfo(path: string): ProcessInfo | undefined {
  const parsed = readJson(path);
  if (
    !isRecord(parsed) ||
    typeof parsed.pid !== "number" ||
    !isHost(parsed.host) ||
    typeof parsed.startedAt !== "string"
  ) {
    return undefined;
  }
  const artifacts = optionalString(parsed.artifacts);
  const socket = optionalString(parsed.socket);
  const version = optionalString(parsed.marbles);
  return {
    ...(artifacts === undefined ? {} : { artifacts }),
    config: typeof parsed.config === "string" ? parsed.config : null,
    host: parsed.host,
    pid: parsed.pid,
    ...(socket === undefined ? {} : { socket }),
    startedAt: parsed.startedAt,
    ...(version === undefined ? {} : { version }),
  };
}
