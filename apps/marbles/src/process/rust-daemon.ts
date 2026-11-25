import { type ChildProcess, spawn } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  statSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Layout } from "~/layout";
import { ProcessHeldError, readProcess, STATE_MODE } from "~/process/instance";
import { RUNTIME_FLAGS, runtime } from "~/process/runtime";
import { recordSpawned, SPAWN_RECOVERY_ENV } from "~/process/spawned";
import { version as marblesVersion } from "../../package.json";

export const CLAIM_HELD_EXIT_CODE = 75;
export const DAEMON_BIN_ENV = "MARBLES_DAEMON_BIN";

const BINARY_NAME =
  process.platform === "win32" ? "marbles-daemon.exe" : "marbles-daemon";
const LOG_FILE = "daemon.log";
const SIGNAL_EXIT_BASE = 128;

type Env = Readonly<Record<string, string | undefined>>;

export interface RustDaemonArgsOptions {
  readonly layout: Layout;
  readonly selfRecycle?: boolean;
}

function isSourceModule(): boolean {
  return import.meta.url.endsWith(".ts");
}

function entryPath(name: string): string {
  const extension = isSourceModule() ? "ts" : "js";
  return fileURLToPath(new URL(`./${name}.${extension}`, import.meta.url));
}

function installationRoot(generationEntry: string): string {
  return isSourceModule()
    ? dirname(dirname(generationEntry))
    : dirname(generationEntry);
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

function workspaceBinary(dir: string): string | undefined {
  const repoRoot = resolve(dir, isSourceModule() ? "../../../.." : "../../..");
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

export function resolveDaemonBinary(
  env: Env = process.env
): string | undefined {
  const configured = env[DAEMON_BIN_ENV];
  if (configured !== undefined && configured !== "") {
    if (executableMtime(configured) === undefined) {
      throw new Error(
        `${DAEMON_BIN_ENV} names ${configured}, which is not an executable file`
      );
    }
    return configured;
  }
  const dir = dirname(fileURLToPath(import.meta.url));
  const sibling = join(dir, BINARY_NAME);
  if (executableMtime(sibling) !== undefined) {
    return sibling;
  }
  return workspaceBinary(dir);
}

export function rustDaemonArgs(options: RustDaemonArgsOptions): string[] {
  const generation = entryPath("generation");
  const bin = runtime();
  const args = [
    "--home",
    options.layout.home,
    "--version",
    marblesVersion,
    "--init-cmd",
    bin,
    ...RUNTIME_FLAGS.flatMap((flag) => ["--init-arg", flag]),
    "--init-arg",
    entryPath("initialize"),
    "--generation-cmd",
    bin,
    ...RUNTIME_FLAGS.flatMap((flag) => ["--generation-arg", flag]),
    "--generation-arg",
    generation,
    "--installation-root",
    installationRoot(generation),
  ];
  if (options.selfRecycle === false) {
    args.push("--no-self-recycle");
  }
  return args;
}

function daemonEnv(
  layout: Layout,
  env: Env
): Record<string, string | undefined> {
  return { ...env, FOUNDRY_HOME: layout.home };
}

function spawned(child: ChildProcess): Promise<void> {
  return new Promise((resolveSpawn, reject) => {
    child.on("error", reject);
    child.once("spawn", resolveSpawn);
  });
}

export async function spawnDetachedRustDaemon(
  layout: Layout,
  env: Env = process.env
): Promise<boolean> {
  const binary = resolveDaemonBinary(env);
  if (binary === undefined) {
    return false;
  }
  mkdirSync(dirname(layout.state), { recursive: true });
  mkdirSync(layout.state, { mode: STATE_MODE, recursive: true });
  const log = openSync(join(layout.state, LOG_FILE), "a");
  try {
    const child = spawn(binary, rustDaemonArgs({ layout }), {
      detached: true,
      env: daemonEnv(layout, env),
      stdio: ["ignore", log, log],
    });
    const acknowledged = spawned(child);
    child.unref();
    await acknowledged;
    recordSpawned(child.pid, true, { ...env, [SPAWN_RECOVERY_ENV]: undefined });
  } finally {
    closeSync(log);
  }
  return true;
}

interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function closed(child: ChildProcess): Promise<Exit> {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
}

export async function runRustDaemon(options: {
  readonly layout: Layout;
}): Promise<boolean> {
  const binary = resolveDaemonBinary();
  if (binary === undefined) {
    return false;
  }
  const { layout } = options;
  const child = spawn(binary, rustDaemonArgs({ layout }), {
    env: daemonEnv(layout, process.env),
    stdio: "inherit",
  });
  recordSpawned(child.pid, false, {
    ...process.env,
    [SPAWN_RECOVERY_ENV]: undefined,
  });
  const forward = (signal: NodeJS.Signals) => {
    child.kill(signal);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  try {
    const { code, signal } = await closed(child);
    if (code === CLAIM_HELD_EXIT_CODE) {
      const status = readProcess(layout.state);
      throw new ProcessHeldError(
        layout.state,
        status?.pid === null || status === undefined
          ? "another process"
          : `process ${String(status.pid)}`,
        status
      );
    }
    if (code !== null && code !== 0) {
      process.exitCode = code;
    } else if (code === null && signal !== null) {
      process.exitCode = SIGNAL_EXIT_BASE + (osConstants.signals[signal] ?? 1);
    }
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  }
  return true;
}
