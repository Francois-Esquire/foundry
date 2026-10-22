import { rmSync } from "node:fs";
import { join } from "node:path";

import { lockHolder, processAlive } from "@foundry/lib/file-lock";

import { isRecord, readJson, writeJson } from "~/lib/state/json";
import { acquireLock } from "~/lib/state/locks";

/**
 * One Marbles process per workspace. Whatever owns a workspace's engine for
 * a while — the dashboard, a headless `run`, an MCP host — claims
 * `locks/process` under the workspace's state dir and describes itself in
 * `process.json` beside it. A second one is told who has it and does not
 * start. The lock is the claim: it holds the owner's pid, and one left by a
 * process that has exited is taken over (the `@foundry/lib/file-lock`
 * protocol, through `acquireLock`). The json is what `status` shows; a crash
 * can leave it behind, so nothing decides liveness from it.
 *
 * One-shot commands (`roll`) do not claim: the schedule and run locks keep
 * them apart from a running process already.
 */

const LOCK = "process";
const FILE = "process.json";

export type ProcessHost = "dashboard" | "headless" | "mcp";

/** What the owning process records about itself. */
export interface ProcessInfo {
  /** The authoring source it loaded; null without one. */
  readonly config: string | null;
  readonly host: ProcessHost;
  readonly pid: number;
  readonly startedAt: string;
}

/** The claim this process holds; `release` runs once. */
export interface ProcessInstance extends ProcessInfo {
  release(): void;
}

/** What `status` reads: the claim as the files describe it right now. */
export interface ProcessStatus {
  /** The lock names a pid, and that pid is running. */
  readonly alive: boolean;
  readonly config: string | null;
  readonly host: ProcessHost | null;
  /** The lock's holder, else what `process.json` last recorded. */
  readonly pid: number | null;
  readonly startedAt: string | null;
}

/** Another process owns this workspace; `holder` says who, for people. */
export class ProcessHeldError extends Error {
  override readonly name = "ProcessHeldError";
  readonly holder: string;

  constructor(dir: string, holder: string, info: ProcessStatus | undefined) {
    const since =
      info?.alive && info.startedAt !== null ? ` since ${info.startedAt}` : "";
    const host = info?.alive && info.host !== null ? ` (${info.host})` : "";
    super(
      `this workspace already has a Marbles process: ${holder}${host}${since}. Stop it first, or point --state elsewhere (state: ${dir}).`
    );
    this.holder = holder;
  }
}

/**
 * Claim `dir` for this process, or throw `ProcessHeldError` naming who has
 * it. Call it before the engine starts: starting is what adopts parked runs.
 */
export function claimProcess(
  dir: string,
  { config, host }: Pick<ProcessInfo, "config" | "host">
): ProcessInstance {
  const lock = acquireLock(dir, LOCK);
  if ("holder" in lock) {
    throw new ProcessHeldError(dir, lock.holder, readProcess(dir));
  }
  const info: ProcessInfo = {
    config,
    host,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const path = join(dir, FILE);
  try {
    writeJson(path, { ...info, version: 1 });
  } catch (error) {
    lock.release();
    throw error;
  }
  let released = false;
  return {
    ...info,
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
  return {
    alive,
    config: described ? info.config : null,
    host: described ? info.host : null,
    pid: holder ?? info?.pid ?? null,
    startedAt: described ? info.startedAt : null,
  };
}

function isHost(value: unknown): value is ProcessHost {
  return value === "dashboard" || value === "headless" || value === "mcp";
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
  return {
    config: typeof parsed.config === "string" ? parsed.config : null,
    host: parsed.host,
    pid: parsed.pid,
    startedAt: parsed.startedAt,
  };
}
