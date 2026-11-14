/**
 * Run recovery across real processes over one JSON state dir. Each phase is
 * its own `bun` process hosting one step on a test engine: a paused run is
 * adopted and resumed by the next process, and a run whose new owner is
 * killed with SIGKILL after it resumed is recorded interrupted by the one
 * after that.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const SRC = resolve("src");
const HELPERS = resolve("test/helpers");
const PROCESS_TIMEOUT = 60_000;
const TEST_TIMEOUT = 180_000;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

/**
 * A host process for `root/state` with one step, `hold`, and `body`. The
 * step records each entry's pid; under `MARBLES_TEST_HOLD` it waits for its
 * signal, under `MARBLES_TEST_CRASH` it kills its process, and otherwise it
 * returns.
 */
function phase(root: string, name: string, body: string): string {
  const script = join(root, `${name}.ts`);
  writeFileSync(
    script,
    `import { appendFileSync } from "node:fs";
import { step } from ${JSON.stringify(join(SRC, "authoring/index.ts"))};
import { testEngine } from ${JSON.stringify(join(HELPERS, "engine.ts"))};
step("hold").do(({ signal }) => {
  appendFileSync(${JSON.stringify(join(root, "entries.log"))}, process.pid + "\\n");
  if (process.env.MARBLES_TEST_CRASH === "1") process.kill(process.pid, "SIGKILL");
  if (process.env.MARBLES_TEST_HOLD !== "1") return "done";
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
});
const lines = [];
const engine = testEngine({ askable: true, print: (line) => lines.push(line), state: ${JSON.stringify(join(root, "state"))} });
await engine.start();
const report = { pid: process.pid };
const until = async (check) => {
  for (let i = 0; i < 1500; i += 1) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error("timed out: " + JSON.stringify(await engine.runs()));
};
const status = async (id) => (await engine.runs()).find((run) => run.id === id)?.status;
${body}
report.lines = lines;
await engine.dispose();
process.stdout.write(JSON.stringify(report) + "\\n");
process.exit(0);
`
  );
  return script;
}

function run(
  script: string,
  env: Record<string, string> = {}
): Record<string, unknown> {
  const output = execFileSync("bun", [script], {
    cwd: resolve("."),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: PROCESS_TIMEOUT,
  });
  return JSON.parse(output.trim().split("\n").at(-1) ?? "{}");
}

function entries(root: string): string[] {
  const path = join(root, "entries.log");
  return existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    : [];
}

/** The first process: `hold` launched, paused mid-body, and the host quit. */
function pausedRun(root: string): string {
  const pause = phase(
    root,
    "pause",
    `const launched = await engine.launch("hold", {});
launched.result.catch(() => undefined);
report.runId = launched.id;
await until(async () => (await status(launched.id)) === "running");
await new Promise((done) => setTimeout(done, 50));
report.paused = engine.pause(launched.id, "hold");
await until(async () => (await status(launched.id)) === "suspended");
await engine.stop({ cancel: true });`
  );
  const paused = run(pause, { MARBLES_TEST_HOLD: "1" });
  expect(paused.paused).toBe(true);
  const runId = paused.runId as string;
  expect(
    JSON.parse(
      readFileSync(join(root, "state", "runs", `${runId}.json`), "utf8")
    ).run.status
  ).toBe("suspended");
  return runId;
}

it(
  "a paused run outlives its process: the next one adopts it and resumes it in the same run",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "marbles-recovery-paused-"));
    roots.push(root);
    const runId = pausedRun(root);

    const resume = phase(
      root,
      "resume",
      `const id = ${JSON.stringify(runId)};
report.adopted = await status(id);
report.owner = engine.executions.get(id)?.owner.pid;
await engine.resume(id, "hold");
await until(async () => (await status(id)) === "complete");
report.output = (await engine.runs()).find((run) => run.id === id)?.output;
report.runs = (await engine.runs()).length;`
    );
    const resumed = run(resume);
    expect(resumed.lines).toContain(`[run] hold recovered ${runId}`);
    expect(resumed.adopted).toBe("suspended");
    expect(resumed.owner).toBe(resumed.pid);
    expect(resumed.output).toBe("done");
    expect(resumed.runs).toBe(1);
    const [first, second] = entries(root);
    expect(entries(root)).toHaveLength(2);
    expect(first).not.toBe(second);
    expect(second).toBe(String(resumed.pid));
  },
  TEST_TIMEOUT
);

it(
  "a run whose new owner is killed after it resumed is recorded interrupted, and nothing adopts it",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "marbles-recovery-crashed-"));
    roots.push(root);
    const runId = pausedRun(root);

    // The second process adopts and resumes the run, which kills it.
    const resume = phase(
      root,
      "resume",
      `await engine.resume(${JSON.stringify(runId)}, "hold");
await new Promise(() => undefined);`
    );
    let killed: unknown;
    try {
      run(resume, { MARBLES_TEST_CRASH: "1" });
    } catch (error) {
      killed = (error as { signal?: string }).signal;
    }
    expect(killed).toBe("SIGKILL");
    expect(entries(root)).toHaveLength(2);

    // The third finds the run its dead owner was running.
    const inspect = phase(
      root,
      "inspect",
      `const id = ${JSON.stringify(runId)};
report.execution = engine.executions.get(id);
report.status = await status(id);`
    );
    const inspected = run(inspect);
    expect(inspected.lines).not.toContain(`[run] hold recovered ${runId}`);
    expect(inspected.execution).toMatchObject({
      error: { code: "interrupted" },
      owner: { pid: inspected.pid },
      status: "interrupted",
    });
    expect(inspected.status).not.toBe("suspended");
    // Nothing ran it again.
    expect(entries(root)).toHaveLength(2);
  },
  TEST_TIMEOUT
);
