import { rmSync } from "node:fs";
import { join } from "node:path";

import { lockOwner } from "@foundry/lib/node/file-lock";
import { isGone } from "@foundry/lib/node/process-identity";

import { isRecord, readJson, writeJson } from "~/state/json";
import { acquireLock, PROCESS_LOCK as LOCK } from "~/state/locks";

const FILE = "process.json";

export const STATE_MODE = 0o700;

export type ProcessHost = "daemon" | "worker";

export interface ProcessInfo {
  readonly artifacts?: string;
  readonly config?: string | null;
  readonly host: ProcessHost;
  readonly pid: number;
  readonly socket?: string;
  readonly startedAt: string;
  readonly version?: string;
}

export interface ProcessInstance extends ProcessInfo {
  release(): void;
}

export interface ProcessStatus {
  readonly alive: boolean;
  readonly artifacts: string | null;
  readonly config: string | null;
  readonly host: ProcessHost | null;
  readonly pid: number | null;
  readonly socket: string | null;
  readonly startedAt: string | null;
  readonly version: string | null;
}

export class ProcessHeldError extends Error {
  override readonly name = "ProcessHeldError";
  readonly holder: string;

  constructor(dir: string, holder: string, info: ProcessStatus | undefined) {
    const since =
      info?.alive && info.startedAt !== null ? ` since ${info.startedAt}` : "";
    const host = info?.alive && info.host !== null ? ` (${info.host})` : "";
    super(
      `a Marbles process already runs here: ${holder}${host}${since}. Stop it first, or set FOUNDRY_ROOT to another Foundry home (state: ${dir}).`
    );
    this.holder = holder;
  }
}

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
      if (readInfo(path)?.pid === process.pid) {
        rmSync(path, { force: true });
      }
      lock.release();
    },
  };
}

export function readProcess(dir: string): ProcessStatus | undefined {
  const owner = lockOwner(join(dir, "locks", LOCK));
  const holder = owner?.pid;
  const info = readInfo(join(dir, FILE));
  if (holder === undefined && info === undefined) {
    return undefined;
  }
  const alive = owner !== undefined && !isGone(owner);
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
