/**
 * Run recovery across real processes over one JSON state dir. Each phase is
 * its own `bun` process hosting one step on a test engine: a run paused, or
 * parked on a question, is adopted by the next process and resumed or
 * answered there, and a run whose new owner is killed with SIGKILL after it
 * resumed is recorded interrupted by the one after that.
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
const ASK = { MARBLES_TEST_ASK: "1" };

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

/**
 * A host process for `root/state` with one step, `hold`, and `body`. The
 * step records each entry's pid; under `MARBLES_TEST_ASK` it asks a
 * question and records the answer, under `MARBLES_TEST_CRASH` it then kills
 * its process, under `MARBLES_TEST_HOLD` it waits for its signal, and
 * otherwise it returns.
 */
function phase(root: string, name: string, body: string): string {
  const script = join(root, `${name}.ts`);
  writeFileSync(
    script,
    `import { appendFileSync } from "node:fs";
import { step } from ${JSON.stringify(join(SRC, "authoring/index.ts"))};
import { testEngine } from ${JSON.stringify(join(HELPERS, "engine.ts"))};
step("hold").do(async ({ ask, signal }) => {
  appendFileSync(${JSON.stringify(join(root, "entries.log"))}, process.pid + "\\n");
  if (process.env.MARBLES_TEST_ASK === "1") {
    const answer = await ask.question({ title: "Go on?" });
    appendFileSync(${JSON.stringify(join(root, "answers.log"))}, JSON.stringify(answer) + "\\n");
  }
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

function lines(root: string, file: string): string[] {
  const path = join(root, file);
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

/** The first process: `hold` launched, parked on its question, and the host quit. */
function parkedRun(root: string): string {
  const park = phase(
    root,
    "park",
    `const launched = await engine.launch("hold", {});
launched.result.catch(() => undefined);
report.runId = launched.id;
await until(async () => (await status(launched.id)) === "suspended");
report.questions = (await engine.feed()).filter((entry) => entry.input?.status === "open").map((entry) => entry.title);
await engine.stop({ cancel: true });`
  );
  const parked = run(park, ASK);
  expect(parked.questions).toEqual(["Go on?"]);
  const runId = parked.runId as string;
  expect(
    JSON.parse(
      readFileSync(join(root, "state", "runs", `${runId}.json`), "utf8")
    ).run.status
  ).toBe("suspended");
  expect(lines(root, "entries.log")).toHaveLength(1);
  expect(lines(root, "answers.log")).toEqual([]);
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
    const [first, second] = lines(root, "entries.log");
    expect(lines(root, "entries.log")).toHaveLength(2);
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
    expect(lines(root, "entries.log")).toHaveLength(2);

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
    expect(lines(root, "entries.log")).toHaveLength(2);
  },
  TEST_TIMEOUT
);

it(
  "a run parked on a question outlives its process: the next one adopts it, and the answer finishes the same run",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "marbles-recovery-parked-"));
    roots.push(root);
    const runId = parkedRun(root);

    const answer = phase(
      root,
      "answer",
      `const id = ${JSON.stringify(runId)};
report.adopted = await status(id);
report.owner = engine.executions.get(id)?.owner.pid;
const question = (await engine.feed()).find((entry) => entry.input?.status === "open");
report.question = question?.title;
await engine.answer(question.id, "yes");
await until(async () => (await status(id)) === "complete");
report.output = (await engine.runs()).find((run) => run.id === id)?.output;
report.runs = (await engine.runs()).length;`
    );
    const answered = run(answer, ASK);
    expect(answered.lines).toContain(`[run] hold recovered ${runId}`);
    expect(answered.adopted).toBe("suspended");
    expect(answered.owner).toBe(answered.pid);
    expect(answered.question).toBe("Go on?");
    expect(answered.output).toBe("done");
    expect(answered.runs).toBe(1);
    expect(lines(root, "answers.log")).toEqual(['"yes"']);
    expect(lines(root, "entries.log").at(-1)).toBe(String(answered.pid));
  },
  TEST_TIMEOUT
);

it(
  "a run whose new owner is killed after the answer is recorded interrupted, and nothing adopts it",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "marbles-recovery-answered-"));
    roots.push(root);
    const runId = parkedRun(root);

    // The second process answers the question, and the resumed run kills it.
    const answer = phase(
      root,
      "answer",
      `const question = (await engine.feed()).find((entry) => entry.input?.status === "open");
await engine.answer(question.id, "yes");
await new Promise(() => undefined);`
    );
    let killed: unknown;
    try {
      run(answer, { ...ASK, MARBLES_TEST_CRASH: "1" });
    } catch (error) {
      killed = (error as { signal?: string }).signal;
    }
    expect(killed).toBe("SIGKILL");
    expect(lines(root, "answers.log")).toEqual(['"yes"']);
    const entered = lines(root, "entries.log").length;

    // The third finds the run its dead owner was running.
    const inspect = phase(
      root,
      "inspect",
      `const id = ${JSON.stringify(runId)};
report.execution = engine.executions.get(id);
report.status = await status(id);
report.questions = (await engine.feed()).filter((entry) => entry.input?.status === "open").length;`
    );
    const inspected = run(inspect, ASK);
    expect(inspected.lines).not.toContain(`[run] hold recovered ${runId}`);
    expect(inspected.execution).toMatchObject({
      error: { code: "interrupted" },
      owner: { pid: inspected.pid },
      status: "interrupted",
    });
    expect(inspected.status).not.toBe("suspended");
    expect(inspected.questions).toBe(0);
    // Nothing ran it again or asked again.
    expect(lines(root, "entries.log")).toHaveLength(entered);
    expect(lines(root, "answers.log")).toEqual(['"yes"']);
  },
  TEST_TIMEOUT
);
