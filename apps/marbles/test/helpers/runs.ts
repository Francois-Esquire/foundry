import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { markedProcesses, stopProcesses } from "./processes";

/**
 * One test run: a root directory that holds everything the run makes, and
 * a marker, `MARBLES_TEST_RUN=<root>`, in the environment of every process
 * it starts. A run is live while its main process listens on the socket
 * in its root; the system closes that listener when the process dies,
 * however it dies, so a run that cannot be reached there is over. A run
 * that never says, a root with no socket, is treated as live, since its
 * owner may be starting or may be a suite that knows nothing of this.
 */
export interface Run {
  /** Stop what the run left running, then remove its root. */
  finish(): Promise<void>;
  readonly root: string;
}

export const RUN_ENV = "MARBLES_TEST_RUN";
export const RUN_PREFIX = "marbles-run-";
const RUN_SOCKET = "run.sock";

/** Start a run under `parent`, live once this resolves. */
export async function startRun(parent: string): Promise<Run> {
  const root = mkdtempSync(join(parent, RUN_PREFIX));
  const server = await listenLive(root);
  return {
    async finish() {
      // A root whose processes would not stop is kept, its socket still
      // bound, so the next run's sweep finds the run over and tries again.
      if (await stopMarked(root)) {
        server.close();
        removeRoot(root);
      }
    },
    root,
  };
}

/**
 * Clean up after every run under `parent` that is over: stop the
 * processes that carry its marker, then remove its root. A run that is
 * live, or cannot be shown over, is left alone.
 */
export async function sweepFinishedRuns(parent: string): Promise<void> {
  const roots = readdirSync(parent)
    .filter((name) => name.startsWith(RUN_PREFIX))
    .map((name) => join(parent, name));
  for (const root of roots) {
    if ((await isOver(root)) && (await stopMarked(root))) {
      removeRoot(root);
    }
  }
}

/**
 * Listen under another name and rename the socket into place, so whoever
 * finds `run.sock` finds it accepting: between bind and listen a connect
 * is refused, which would read as a run that is over.
 */
async function listenLive(root: string): Promise<Server> {
  const binding = join(root, `${RUN_SOCKET}.new`);
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(binding, () => {
      server.off("error", reject);
      resolve();
    });
  });
  renameSync(binding, join(root, RUN_SOCKET));
  // The run is over when vitest is; the listener must not keep it alive.
  server.unref();
  return server;
}

/**
 * Refused twice, a moment apart: macOS also refuses a connect when the
 * listener's backlog is full, which a second try outlasts.
 */
async function isOver(root: string): Promise<boolean> {
  if ((await runState(root)) !== "over") {
    return false;
  }
  await sleep(200);
  return (await runState(root)) === "over";
}

type RunState = "live" | "over" | "unknown";

/**
 * Bun reports a connect that nothing listens for as ENOENT, even though
 * the socket is there, where the system says ECONNREFUSED; so a refusal
 * counts only while the socket file itself exists.
 */
const REFUSED = new Set(["ECONNREFUSED", "ENOENT"]);

function runState(root: string): Promise<RunState> {
  const path = join(root, RUN_SOCKET);
  return new Promise((resolve) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve("live");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      const refused = REFUSED.has(error.code ?? "") && isSocket(path);
      resolve(refused ? "over" : "unknown");
    });
  });
}

function isSocket(path: string): boolean {
  try {
    return lstatSync(path).isSocket();
  } catch {
    return false;
  }
}

/** Whether every process carrying the run's marker is confirmed gone. */
async function stopMarked(root: string): Promise<boolean> {
  const survivors = await stopProcesses(markedProcesses(RUN_ENV, root));
  if (survivors.length > 0) {
    console.warn(
      `marbles tests: kept ${root}; its processes ${survivors.join(", ")} would not stop`
    );
  }
  return survivors.length === 0;
}

/**
 * Remove a run's root, and only it: recursive removal deletes a symbolic
 * link inside it, not what the link points to. A failure warns rather
 * than failing the run; the next run's sweep tries again.
 */
function removeRoot(root: string): void {
  try {
    rmSync(root, { maxRetries: 3, recursive: true });
  } catch (error) {
    console.warn(
      `marbles tests: could not remove the run's root ${root}: ${String(error)}`
    );
  }
}
