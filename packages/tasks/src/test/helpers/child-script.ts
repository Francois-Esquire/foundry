import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** A script running in another process of this runtime, read line by line. */
export interface ChildScript {
  /** Waits for the process to exit; rejects unless it exited with 0. */
  readonly exited: (ms?: number) => Promise<void>;
  /**
   * The next line the script prints, once it has printed one. Rejects if
   * the process errors or exits first, or after `ms`.
   */
  readonly line: (ms?: number) => Promise<string>;
  /** Kills the process if it still runs, reaps it, and removes the script. */
  readonly stop: () => Promise<void>;
}

const STARTUP = 10_000;

/** Runs `source` as an ES module with `args`, on this process's runtime. */
export async function startScript(
  source: string,
  args: readonly string[]
): Promise<ChildScript> {
  const directory = await mkdtemp(join(tmpdir(), "foundry-child-"));
  const script = join(directory, "script.mjs");
  await writeFile(script, source);
  const child = spawn(process.execPath, [script, ...args], {
    stdio: ["ignore", "pipe", "inherit"],
  });

  // Settled once, whatever happens, with handlers attached at once.
  const ended = new Promise<{ code: number | null; error?: Error }>(
    (resolve) => {
      child.once("error", (error) => resolve({ code: null, error }));
      // `close`, not `exit`: it follows the last of the output.
      child.once("close", (code) => resolve({ code }));
    }
  );
  const lines: string[] = [];
  const waiting: (() => void)[] = [];
  createInterface({ input: child.stdout }).on("line", (text) => {
    lines.push(text);
    for (const wake of waiting.splice(0)) {
      wake();
    }
  });

  function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`child script: no ${what} in ${ms} ms`)),
        ms
      );
    });
    return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
  }

  const failure = ended.then(({ code, error }) => {
    throw error ?? new Error(`child script exited with ${String(code)}`);
  });
  failure.catch(() => undefined);

  return {
    exited: (ms = STARTUP) =>
      within(
        ms,
        "exit",
        ended.then(({ code, error }) => {
          if (error !== undefined || code !== 0) {
            throw (
              error ?? new Error(`child script exited with ${String(code)}`)
            );
          }
        })
      ),
    line: (ms = STARTUP) =>
      within(
        ms,
        "line",
        Promise.race([
          new Promise<string>((resolve) => {
            const take = () => {
              const next = lines.shift();
              if (next === undefined) {
                waiting.push(take);
              } else {
                resolve(next);
              }
            };
            take();
          }),
          failure,
        ])
      ),
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
      await ended;
      await rm(directory, { force: true, recursive: true });
    },
  };
}
