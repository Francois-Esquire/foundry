import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import type { Layout } from "~/layout";
import { connect } from "~/process/client";
import { ProcessHeldError, readProcess } from "~/process/instance";
import {
  CLAIM_HELD_EXIT_CODE,
  DAEMON_BIN_ENV,
  resolveDaemonBinary,
  rustDaemonArgs,
} from "~/process/rust-daemon";
import { recordSpawned, SPAWN_RECOVERY_ENV } from "~/process/spawned";

const BINARY_NAME = "marbles-daemon";
const START_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 2000;
const TERMINATE_GRACE_MS = 2000;
const STOP_TIMEOUT_MS = 60_000;
const RETRY_MS = 50;

export interface RustDaemonOptions {
  readonly binary?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly layout: Layout;
  readonly print?: (line: string) => void;
  readonly selfRecycle?: boolean;
  readonly timeoutMs?: number;
}

export interface RustDaemon {
  close(): Promise<void>;
  readonly closed: Promise<void>;
  readonly pid: number;
  readonly socket: string;
}

function executableMtime(path: string): number | undefined {
  try {
    accessSync(path, constants.X_OK);
    const stat = statSync(path);
    return stat.isFile() ? stat.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

export function workspaceDaemonBinary(): string | undefined {
  const configured = resolveDaemonBinary();
  if (configured !== undefined) {
    return configured;
  }
  const repoRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    ".."
  );
  if (!existsSync(join(repoRoot, "crates", "marbles-daemon", "Cargo.toml"))) {
    return undefined;
  }
  let best: { readonly mtime: number; readonly path: string } | undefined;
  for (const profile of ["release", "debug"]) {
    const path = join(repoRoot, "target", profile, BINARY_NAME);
    const mtime = executableMtime(path);
    if (mtime !== undefined && (best === undefined || mtime > best.mtime)) {
      best = { mtime, path };
    }
  }
  return best?.path;
}

function pipeLines(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void
): void {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  stream.on("data", (chunk: Buffer | string) => {
    pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      onLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  });
  stream.on("end", () => {
    const rest = pending + decoder.end();
    if (rest.length > 0) {
      onLine(rest);
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

interface Tracked {
  readonly closed: Promise<void>;
  readonly exitCode: () => number | null;
  readonly exited: () => boolean;
  readonly spawnError: () => Error | undefined;
}

function track(child: ChildProcess): Tracked {
  let exited = false;
  let exitCode: number | null = null;
  let spawnError: Error | undefined;
  const closed = new Promise<void>((resolveClosed) => {
    child.once("error", (error) => {
      spawnError = error;
      exited = true;
      resolveClosed();
    });
    child.once("close", (code) => {
      exitCode = code;
      exited = true;
      resolveClosed();
    });
  });
  return {
    closed,
    exitCode: () => exitCode,
    exited: () => exited,
    spawnError: () => spawnError,
  };
}

async function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolveTimeout) => {
        timer = setTimeout(resolveTimeout, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function terminate(child: ChildProcess, tracked: Tracked): Promise<void> {
  if (tracked.exited()) {
    return;
  }
  child.kill("SIGTERM");
  await withTimeout(tracked.closed, TERMINATE_GRACE_MS);
  if (!tracked.exited()) {
    child.kill("SIGKILL");
  }
  await tracked.closed;
}

async function answeredPid(layout: Layout): Promise<number | undefined> {
  try {
    const client = await connect({
      layout,
      start: false,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    try {
      return client.hello.pid;
    } finally {
      client.close();
    }
  } catch {
    return undefined;
  }
}

function earlyExitError(
  tracked: Tracked,
  stderrLines: readonly string[],
  layout: Layout
): Error {
  const spawnError = tracked.spawnError();
  if (spawnError !== undefined) {
    return spawnError;
  }
  const code = tracked.exitCode();
  if (code === CLAIM_HELD_EXIT_CODE) {
    const status = readProcess(layout.state);
    return new ProcessHeldError(
      layout.state,
      status?.pid === null || status === undefined
        ? "another process"
        : `process ${String(status.pid)}`,
      status
    );
  }
  return new Error(
    stderrLines.join("\n").trim() ||
      `marbles-daemon exited with code ${String(code)} before listening on ${layout.socket}`
  );
}

async function waitUntilReady(
  child: ChildProcess,
  tracked: Tracked,
  stderrLines: readonly string[],
  layout: Layout,
  timeoutMs: number
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tracked.exited()) {
      throw earlyExitError(tracked, stderrLines, layout);
    }
    const pid = await answeredPid(layout);
    if (pid !== undefined && pid === child.pid) {
      return pid;
    }
    if (Date.now() > deadline) {
      await terminate(child, tracked);
      throw new Error(
        `marbles-daemon did not answer on ${layout.socket} within ${String(timeoutMs)}ms`
      );
    }
    await sleep(RETRY_MS);
  }
}

async function shutdownOwned(layout: Layout, pid: number): Promise<boolean> {
  let client: Awaited<ReturnType<typeof connect>>;
  try {
    client = await connect({
      layout,
      start: false,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  } catch {
    return false;
  }
  try {
    if (client.hello.pid !== pid) {
      return false;
    }
    await client.shutdown();
    return true;
  } catch {
    return false;
  } finally {
    client.close();
  }
}

async function stop(
  child: ChildProcess,
  tracked: Tracked,
  layout: Layout,
  pid: number
): Promise<void> {
  if (tracked.exited()) {
    return;
  }
  const asked = await shutdownOwned(layout, pid);
  if (!(asked || tracked.exited())) {
    child.kill("SIGTERM");
  }
  await withTimeout(tracked.closed, STOP_TIMEOUT_MS);
  if (!tracked.exited()) {
    child.kill("SIGKILL");
  }
  await tracked.closed;
}

export async function startRustDaemon(
  options: RustDaemonOptions
): Promise<RustDaemon> {
  const env = options.env ?? process.env;
  const binary = options.binary ?? resolveDaemonBinary(env);
  if (binary === undefined) {
    throw new Error(
      `marbles-daemon binary not found; build it with \`cargo build -p marbles-daemon\` or set ${DAEMON_BIN_ENV}`
    );
  }
  const { layout } = options;
  const child = spawn(binary, rustDaemonArgs(options), {
    env: { ...env, FOUNDRY_HOME: layout.home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  recordSpawned(child.pid, false, { ...env, [SPAWN_RECOVERY_ENV]: undefined });
  const stderrLines: string[] = [];
  if (child.stdout !== null) {
    pipeLines(child.stdout, (line) => {
      options.print?.(line);
    });
  }
  if (child.stderr !== null) {
    pipeLines(child.stderr, (line) => {
      stderrLines.push(line);
      options.print?.(line);
    });
  }
  const tracked = track(child);
  const readyPid = await waitUntilReady(
    child,
    tracked,
    stderrLines,
    layout,
    options.timeoutMs ?? START_TIMEOUT_MS
  );
  let closing: Promise<void> | undefined;
  return {
    close: () => {
      closing ??= stop(child, tracked, layout, readyPid);
      return closing;
    },
    closed: tracked.closed,
    pid: readyPid,
    socket: layout.socket,
  };
}
