import { spawn } from "node:child_process";
import { createWriteStream, fstatSync } from "node:fs";
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
 */

/** Set in the server's environment only; the server removes it at once. */
const SERVER = "MARBLES_MCP_SERVER";
/** The server's descriptor for protocol frames. */
const PROTOCOL_FD = 3;
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
    stdio: ["inherit", 2, "inherit", "pipe"],
  });
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  for (const signal of FORWARDED) {
    process.on(signal, forward);
  }
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve(code ?? 128 + (signal === null ? 0 : constants.signals[signal]));
    });
  });
  const protocol = child.stdio[PROTOCOL_FD];
  const copied =
    protocol instanceof Readable
      ? pipeline(protocol, createWriteStream("", { fd: 1 })).catch(
          (error: unknown) => {
            // The client stopped reading; the server has nobody to answer.
            process.stderr.write(
              `marbles mcp: ${error instanceof Error ? error.message : String(error)}\n`
            );
            child.kill("SIGTERM");
          }
        )
      : Promise.resolve();
  try {
    const [code] = await Promise.all([exited, copied]);
    process.exitCode = code;
  } finally {
    for (const signal of FORWARDED) {
      process.off(signal, forward);
    }
  }
}
