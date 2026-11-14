import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, fstatSync } from "node:fs";
import { constants } from "node:os";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { RUNTIME_FLAGS, runtime } from "~/process/runtime";

/**
 * `marbles mcp` runs in two processes, so stdout carries protocol frames
 * and nothing else. The relay, the process the client started, spawns the
 * server with its stdout on the relay's stderr, and the protocol on an
 * extra pipe the relay copies to its own stdout. Whatever the server, its
 * source, or anything it spawns prints to stdout reaches stderr, through
 * any writer, on any platform.
 *
 * The pipe is not the relay's stdout itself: Bun applies a child's
 * descriptors in order, so the extra one would be wired from descriptor 1
 * after it already pointed at stderr.
 *
 * A second pipe, which the relay holds and never writes, tells the server
 * the relay is gone: it ends when the relay exits, however it exits, and
 * the server shuts down. A shutdown has a deadline on each side: the
 * server exits when its own passes, and the relay kills a server that
 * outlives the relay's.
 */

/** Set in the server's environment only; the server removes it at once. */
const SERVER = "MARBLES_MCP_SERVER";
/** The server's descriptor for protocol frames. */
const PROTOCOL_FD = 3;
/** The server's descriptor that ends when the relay is gone. */
const RELAY_FD = 4;
/** How long the server's shutdown may take before it exits anyway. */
export const SHUTDOWN_GRACE_MS = 3000;
/** How long after asking the server to stop the relay kills it. */
const KILL_AFTER_MS = SHUTDOWN_GRACE_MS + 2000;
const FORWARDED = ["SIGHUP", "SIGINT", "SIGTERM"] as const;

/** Whether this process is the server a relay started. */
export function isServer(): boolean {
  return process.env[SERVER] !== undefined;
}

/**
 * The stream for protocol frames, in the server a relay started. The
 * marker leaves the environment first, so nothing the server starts, a
 * nested `marbles mcp` among them, takes itself for one.
 */
export function protocolOutput(): Writable {
  delete process.env[SERVER];
  let pipe = false;
  try {
    const stat = fstatSync(PROTOCOL_FD);
    pipe = stat.isFIFO() || stat.isSocket();
  } catch {
    // Not open: refused below.
  }
  if (!pipe) {
    throw new Error(
      `${SERVER} is set but descriptor ${PROTOCOL_FD} is not the protocol pipe; start the server with marbles mcp`
    );
  }
  return createWriteStream("", { fd: PROTOCOL_FD });
}

/** Call `gone` once the relay that started this server is gone. */
export function onRelayGone(gone: () => void): void {
  const held = createReadStream("", { fd: RELAY_FD });
  held.once("close", gone);
  held.once("error", () => held.destroy());
  held.resume();
}

/**
 * Start the server as `entry` with `argv`, and relay until it exits: stdin
 * and stderr are its own, signals are passed on, and its exit code is this
 * process's.
 */
export async function relay(
  entry: string,
  argv: readonly string[]
): Promise<void> {
  const child = spawn(runtime(), [...RUNTIME_FLAGS, entry, ...argv], {
    env: { ...process.env, [SERVER]: "1" },
    stdio: ["inherit", 2, "inherit", "pipe", "pipe"],
  });
  const protocol = child.stdio[PROTOCOL_FD];
  const held = child.stdio[RELAY_FD];
  if (!(protocol instanceof Readable && held instanceof Readable)) {
    child.kill("SIGKILL");
    throw new Error("could not open the pipes to the MCP server");
  }
  // The server never writes to it; it ends when the server exits.
  held.on("error", () => held.destroy());
  held.resume();
  let killer: NodeJS.Timeout | undefined;
  const stop = (signal: NodeJS.Signals): void => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.kill(signal);
    killer ??= setTimeout(() => {
      process.stderr.write(
        `marbles mcp: the server did not stop within ${KILL_AFTER_MS}ms; killing it\n`
      );
      child.kill("SIGKILL");
    }, KILL_AFTER_MS);
  };
  for (const signal of FORWARDED) {
    process.on(signal, stop);
  }
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(killer);
      resolve(code ?? 128 + (signal === null ? 0 : constants.signals[signal]));
    });
  });
  const copied = pipeline(protocol, createWriteStream("", { fd: 1 })).catch(
    (error: unknown) => {
      // The client stopped reading; the server has nobody to answer.
      process.stderr.write(
        `marbles mcp: ${error instanceof Error ? error.message : String(error)}\n`
      );
      stop("SIGTERM");
    }
  );
  try {
    const [code] = await Promise.all([exited, copied]);
    process.exitCode = code;
  } finally {
    for (const signal of FORWARDED) {
      process.off(signal, stop);
    }
  }
}
