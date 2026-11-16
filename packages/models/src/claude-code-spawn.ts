import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { recordGroup } from "@foundry/lib/spawn-record";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";

type SpawnHook = NonNullable<ClaudeCodeSettings["spawnClaudeCodeProcess"]>;

const STDERR_TAIL_BYTES = 8 * 1024;
const STDERR_MARKER = " | stderr (tail):";

const calls = new AsyncLocalStorage<{ tail: string }>();

export const spawnRecordedCli: SpawnHook = (options) => {
  const child = spawn(options.command, options.args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    detached: true,
    env: options.env,
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
  recordGroup(child, { signal: options.signal });
  return child;
};

export function withCliStderr<T>(work: () => PromiseLike<T>): {
  readonly result: Promise<T>;
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
