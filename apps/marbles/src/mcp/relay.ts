import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, fstatSync } from "node:fs";
import { constants } from "node:os";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { RUNTIME_FLAGS, runtime } from "~/process/runtime";
import { recordSpawned } from "~/process/spawned";

const SERVER = "MARBLES_MCP_SERVER";
const PROTOCOL_FD = 3;
const RELAY_FD = 4;
export const SHUTDOWN_GRACE_MS = 3000;
const KILL_AFTER_MS = SHUTDOWN_GRACE_MS + 2000;
const FORWARDED = ["SIGHUP", "SIGINT", "SIGTERM"] as const;

export function isServer(): boolean {
  return process.env[SERVER] !== undefined;
}

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

export function onRelayGone(gone: () => void): void {
  const held = createReadStream("", { fd: RELAY_FD });
  held.once("close", gone);
  held.once("error", () => held.destroy());
  held.resume();
}

export async function relay(
  entry: string,
  argv: readonly string[]
): Promise<void> {
  const child = spawn(runtime(), [...RUNTIME_FLAGS, entry, ...argv], {
    env: { ...process.env, [SERVER]: "1" },
    stdio: ["pipe", 2, "inherit", "pipe", "pipe"],
  });
  const { stdin: input } = child;
  const protocol = child.stdio[PROTOCOL_FD];
  const held = child.stdio[RELAY_FD];
  if (
    !(
      input instanceof Writable &&
      protocol instanceof Readable &&
      held instanceof Readable
    )
  ) {
    child.kill("SIGKILL");
    throw new Error("could not open the pipes to the MCP server");
  }
  held.on("error", () => held.destroy());
  held.resume();
  const running = (): boolean =>
    child.exitCode === null && child.signalCode === null;
  let killer: NodeJS.Timeout | undefined;
  const deadline = (): void => {
    if (!running()) {
      return;
    }
    killer ??= setTimeout(() => {
      process.stderr.write(
        `marbles mcp: the server did not stop within ${KILL_AFTER_MS}ms; killing it\n`
      );
      child.kill("SIGKILL");
    }, KILL_AFTER_MS);
  };
  const stop = (signal: NodeJS.Signals): void => {
    if (running()) {
      child.kill(signal);
      deadline();
    }
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
  recordSpawned(child.pid, false);
  const copied = pipeline(protocol, createWriteStream("", { fd: 1 })).catch(
    (error: unknown) => {
      process.stderr.write(
        `marbles mcp: ${error instanceof Error ? error.message : String(error)}\n`
      );
      stop("SIGTERM");
    }
  );
  pipeline(process.stdin, input)
    .catch(() => undefined)
    .finally(deadline);
  try {
    const [code] = await Promise.all([exited, copied]);
    process.exitCode = code;
  } finally {
    for (const signal of FORWARDED) {
      process.off(signal, stop);
    }
    process.stdin.destroy();
  }
}
