/**
 * How a host Claude Code call starts the CLI: as the Claude Agent SDK's
 * own local spawn does (its stdin and stdout piped, the SDK's signal and
 * environment as given), but recorded (`@foundry/lib/spawn-record`), so a
 * start after its host died can stop a CLI it left running.
 *
 * The SDK reads the CLI's stderr only on its own spawn, for the error a
 * failed call reports. Here each call keeps the tail of it instead
 * (`withCliStderr`), and the provider adds it to the call's error.
 *
 * Node-bound: import it from main-process code only.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { recordChild } from "@foundry/lib/spawn-record";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";

type SpawnHook = NonNullable<ClaudeCodeSettings["spawnClaudeCodeProcess"]>;

/** How much of the CLI's stderr a call keeps, from its end. */
const STDERR_TAIL_BYTES = 8 * 1024;
/** The provider's own marker, so a tail reads as one it added would. */
const STDERR_MARKER = " | stderr (tail):";

const calls = new AsyncLocalStorage<{ tail: string }>();

/** Start the CLI as the SDK would, recorded, its stderr kept for the call. */
export const spawnRecordedCli: SpawnHook = (options) => {
  const child = spawn(options.command, options.args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const call = calls.getStore();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (call) {
      call.tail = (call.tail + chunk).slice(-STDERR_TAIL_BYTES);
    }
  });
  // Once the child is the call's; it never throws.
  recordChild(child);
  return child;
};

/**
 * Run one call with a place for the CLI it starts to leave its stderr,
 * and say what it left: the call's error, with that tail added when the
 * error does not carry one, is what an error rejects with or a stream's
 * error part holds.
 */
export function withCliStderr<T>(work: () => PromiseLike<T>): {
  readonly result: Promise<T>;
  /** `error`, with the CLI's stderr tail added when there is one to add. */
  explain(error: unknown): unknown;
} {
  const call = { tail: "" };
  const explain = (error: unknown): unknown => {
    const tail = call.tail.trim();
    if (
      tail === "" ||
      !(error instanceof Error) ||
      error.message.includes(STDERR_MARKER)
    ) {
      return error;
    }
    error.message = `${error.message}${STDERR_MARKER} ${tail}`;
    return error;
  };
  const result = calls
    .run(call, async () => await work())
    .catch((error: unknown) => {
      throw explain(error);
    });
  return { explain, result };
}
