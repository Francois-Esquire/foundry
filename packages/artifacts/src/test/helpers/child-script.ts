import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface ChildScript {
  readonly exited: (ms?: number) => Promise<void>;
  readonly line: (ms?: number) => Promise<string>;
  readonly stop: (graceMs?: number) => Promise<void>;
}

const STARTUP = 10_000;
const GRACE = 2000;

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

  const ended = new Promise<{ code: number | null; error?: Error }>(
    (resolve) => {
      child.once("error", (error) => resolve({ code: null, error }));
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
    line: (ms = STARTUP) => {
      let take = (): void => undefined;
      const next = new Promise<string>((resolve) => {
        take = () => {
          const line = lines.shift();
          if (line === undefined) {
            waiting.push(take);
          } else {
            resolve(line);
          }
        };
        take();
      });
      return within(ms, "line", Promise.race([next, failure])).finally(() => {
        const at = waiting.indexOf(take);
        if (at !== -1) {
          waiting.splice(at, 1);
        }
      });
    },
    stop: async (graceMs = GRACE) => {
      const running = () =>
        child.exitCode === null && child.signalCode === null;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      if (running()) {
        child.kill("SIGTERM");
        escalation = setTimeout(() => {
          if (running()) {
            child.kill("SIGKILL");
          }
        }, graceMs);
      }
      try {
        await ended;
      } finally {
        clearTimeout(escalation);
      }
      await rm(directory, { force: true, recursive: true });
    },
  };
}
