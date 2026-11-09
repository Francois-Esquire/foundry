/**
 * The task pipeline across real process restarts over one JSON state dir.
 * Each phase is its own `bun` process hosting the pipeline on a test engine
 * with mock models. One is killed with SIGKILL inside its destination run,
 * the way a crash ends a host; another stops while its destination is
 * parked on a question, which the next process adopts and answers; a third
 * stops while its refinement is paused, which the next process resumes; a
 * fourth is killed just before restoring a dropped state, and the next one
 * runs an edited observer that is handed the whole history.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const SRC = resolve("src");
const EXAMPLES = resolve("examples/task-pipeline");
const HELPERS = resolve("test/helpers");

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

/** A host process for `root/state`: the pipeline, one destination double, and `body`. */
function phase(root: string, name: string, body: string): string {
  const zod = createRequire(import.meta.url).resolve("zod");
  const script = join(root, `${name}.ts`);
  writeFileSync(
    script,
    `import { appendFileSync } from "node:fs";
import { step, tasks } from ${JSON.stringify(join(SRC, "authoring/index.ts"))};
import { catalog } from ${JSON.stringify(join(SRC, "authoring/catalog.ts"))};
import { setHost } from ${JSON.stringify(join(SRC, "authoring/runtime.ts"))};
import { testEngine } from ${JSON.stringify(join(HELPERS, "engine.ts"))};
import { taskPipeline } from ${JSON.stringify(join(EXAMPLES, "pipeline.ts"))};
import { destination } from ${JSON.stringify(join(EXAMPLES, "route.ts"))};
import { request, stateOf } from ${JSON.stringify(join(EXAMPLES, "state.ts"))};
import { z } from ${JSON.stringify(zod)};
const log = (file, line) => appendFileSync(${JSON.stringify(root)} + "/" + file, line + "\\n");
const work = step("work-double")
  .input(z.object({ spec: z.string() }))
  .do(async ({ ask }) => {
    log("entries.log", process.pid);
    if (process.env.MARBLES_TEST_ASK === "1") {
      log("answers.log", JSON.stringify(await ask.question({ title: "Go on?" })));
    }
    log("runs.log", process.pid);
    if (process.env.MARBLES_TEST_CRASH === "1") process.kill(process.pid, "SIGKILL");
    if (process.env.MARBLES_TEST_FAIL === "1") throw new Error("failed after its effect");
    return { done: true };
  });
const CLEAR = { acceptance: ["it works"], constraints: [], ready: true, requirements: ["do it"], summary: "Do it.", unknowns: [] };
const reply = (call) => {
  if (call.prompt.includes("You choose how a prepared task")) {
    log("router.log", process.pid);
    return JSON.stringify({ decision: "route", inputJson: "{}", questions: [], reason: "It fits.", workflow: "work-double" });
  }
  log("refiner.log", process.pid);
  return JSON.stringify(CLEAR);
};
const pipeline = taskPipeline({
  destinations: [destination({ build: (brief) => ({ spec: brief.spec }), choose: z.object({}), definition: work, description: "Do the work." })],
  router: { model: "gpt-test-router" },
});
if (process.env.MARBLES_TEST_EDIT_OBSERVER === "1") {
  // An edited observer: new source text, so a new handler hash that is
  // handed the workspace's whole history.
  const [declared] = catalog.observers;
  const original = declared.handler;
  declared.handler = async (event) => {
    await original(event);
  };
}
if (process.env.MARBLES_TEST_RENAME_FIRST !== undefined) {
  // One text in every phase that sets it, so one handler hash. In the seed,
  // it renames the task before the observer handles the drop to { drop: 2 },
  // so that drop is behind the task, and the rename is never delivered.
  const [declared] = catalog.observers;
  const original = declared.handler;
  declared.handler = async (event) => {
    if (process.env.MARBLES_TEST_RENAME_FIRST === "seed") {
      const delta = event.tasks.find((each) => each.after?.metadata.drop === 2);
      if (delta?.after.title === "Renamed") await new Promise(() => undefined);
      if (delta !== undefined) await tasks.update(delta.id, { title: "Renamed" });
    }
    await original(event);
  };
}
const hold =process.env.MARBLES_TEST_HOLD_REFINE === "1" ? (call) => call.prompt.includes("You refine a rough task") : undefined;
const engine = testEngine({ askable: true, hold, print: () => undefined, reply, state: ${JSON.stringify(join(root, "state"))} });
setHost(engine);
await engine.start();
const report = {};
const until = async (check) => {
  for (let i = 0; i < 1500; i += 1) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  const listed = (await tasks.list()).items.map((task) => ({ id: task.id, status: task.status, pipeline: task.metadata.pipeline }));
  const runs = (await engine.runs()).map((run) => ({ id: run.id, status: run.status, step: run.step }));
  throw new Error("timed out: " + JSON.stringify({ listed, runs }));
};
const stage = async (id) => stateOf(await tasks.get(id))?.stage;
${body}
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
    timeout: 60_000,
  });
  return JSON.parse(output.trim().split("\n").at(-1) ?? "{}");
}

function lines(root: string, file: string): string[] {
  const path = join(root, file);
  return existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    : [];
}

it("survives a crash inside the destination run: interrupted, never relaunched by restart or replay, retried once on request", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-pipeline-restart-"));
  roots.push(root);
  const records = join(root, "state", "tasks.json");

  // 1. The task is refined, routed, and running when the host is killed.
  const crash = phase(
    root,
    "crash",
    `const task = await tasks.create({ tags: ["pipeline"], title: "Crash me" });
log("task.id", task.id);
await new Promise(() => undefined);`
  );
  let killed: unknown;
  try {
    run(crash, { MARBLES_TEST_CRASH: "1" });
  } catch (error) {
    killed = (error as { signal?: string }).signal;
  }
  expect(killed).toBe("SIGKILL");
  const [taskId] = lines(root, "task.id");
  const afterCrash = JSON.parse(readFileSync(records, "utf8"));
  const crashed = afterCrash.tasks.find(
    (task: { id: string }) => task.id === taskId
  );
  expect(crashed.status).toBe("active");
  expect(crashed.metadata.pipeline.stage).toBe("running");
  expect(crashed.metadata.pipeline.attempt.runId).toEqual(expect.any(String));
  expect(lines(root, "runs.log")).toHaveLength(1);

  // 2. A new process: its first delivery, or the reconcile step, marks it
  // interrupted, and nothing is launched for it;
  // a retry reuses the recorded route, without asking the router again.
  const restart = phase(
    root,
    "restart",
    `const id = ${JSON.stringify(taskId)};
report.reconciled = (await pipeline.reconcile.run()).interrupted;
report.interrupted = await stage(id);
await new Promise((done) => setTimeout(done, 500));
report.runsBeforeRetry = (await Bun.file(${JSON.stringify(join(root, "runs.log"))}).text()).trim().split("\\n").length;
report.stillInterrupted = await stage(id);
await pipeline.request.run({ action: "retry", taskId: id });
await until(async () => (await stage(id)) === "awaiting-acceptance");
const task = await tasks.get(id);
report.status = task.status;
report.history = stateOf(task).history.map((entry) => entry.stage);
report.route = stateOf(task).route;`
  );
  const restarted = run(restart);
  // Whichever ran first marked it: the redelivered change, or the step.
  expect([[], [taskId]]).toContainEqual(restarted.reconciled);
  expect(restarted.interrupted).toBe("interrupted");
  expect(restarted.stillInterrupted).toBe("interrupted");
  expect(restarted.runsBeforeRetry).toBe(1);
  expect(restarted.status).toBe("active");
  expect(restarted.history).toEqual([
    "intake",
    "prepared",
    "interrupted",
    "prepared",
    "awaiting-acceptance",
  ]);
  expect(restarted.route).toMatchObject({
    source: "retry",
    workflow: "work-double",
  });
  const runs = lines(root, "runs.log");
  expect(runs).toHaveLength(2);
  expect(runs[0]).not.toBe(runs[1]);
  expect(lines(root, "router.log")).toHaveLength(1);
  expect(lines(root, "refiner.log")).toHaveLength(1);

  // 3. Replay everything to a host that has delivered nothing: no launch.
  const replayed = JSON.parse(readFileSync(records, "utf8"));
  for (const item of replayed.items) {
    item.delivered = [];
  }
  writeFileSync(records, JSON.stringify(replayed));
  const replay = phase(
    root,
    "replay",
    `await until(async () => {
  const file = JSON.parse(await Bun.file(${JSON.stringify(records)}).text());
  return file.items.every((item) => item.delivered.length === 1);
});
await new Promise((done) => setTimeout(done, 500));
report.stage = await stage(${JSON.stringify(taskId)});`
  );
  expect(run(replay).stage).toBe("awaiting-acceptance");
  expect(lines(root, "runs.log")).toHaveLength(2);
  expect(lines(root, "router.log")).toHaveLength(1);
  expect(lines(root, "refiner.log")).toHaveLength(1);
}, 180_000);

it("keeps an attempt parked on a question across a restart: not interrupted, no retry beside it, finished by its own run once answered", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-pipeline-parked-"));
  roots.push(root);
  const records = join(root, "state", "tasks.json");
  const ask = { MARBLES_TEST_ASK: "1" };

  // 1. The destination parks on a question; the host stops gracefully.
  const park = phase(
    root,
    "park",
    `const task = await tasks.create({ tags: ["pipeline"], title: "Ask first" });
report.taskId = task.id;
await until(async () => stateOf(await tasks.get(task.id))?.attempt?.parked !== undefined);
await until(async () => (await engine.runs()).some((run) => run.status === "suspended"));
report.state = stateOf(await tasks.get(task.id));
report.status = (await tasks.get(task.id)).status;
report.questions = (await engine.feed()).filter((entry) => entry.input?.status === "open").map((entry) => entry.title);
await engine.stop({ cancel: true });`
  );
  const parked = run(park, ask);
  const taskId = parked.taskId as string;
  const parkedState = parked.state as {
    attempt: { owner: string; parked: string; runId: string };
    stage: string;
  };
  expect(parkedState.stage).toBe("running");
  expect(parkedState.attempt.parked).toEqual(expect.any(String));
  expect(parked.status).toBe("active");
  expect(parked.questions).toEqual(["Go on?"]);
  const { runId } = parkedState.attempt;
  expect(
    JSON.parse(
      readFileSync(join(root, "state", "runs", `${runId}.json`), "utf8")
    ).run.status
  ).toBe("suspended");
  expect(lines(root, "entries.log")).toHaveLength(1);
  expect(lines(root, "runs.log")).toEqual([]);

  // 2. A new process adopts the parked run. Reconcile leaves the attempt to
  // it; retry, reroute, and refine are refused while it can still resume.
  // The answer resumes the same run, which finishes the attempt here.
  const resume = phase(
    root,
    "resume",
    `const id = ${JSON.stringify(taskId)};
report.reconciled = (await pipeline.reconcile.run()).interrupted;
report.afterReconcile = stateOf(await tasks.get(id));
report.refused = [];
for (const action of ["retry", "reroute", "refine", "accept"]) {
  try {
    await pipeline.request.run({ action, taskId: id });
    report.refused.push(action + ": accepted");
  } catch (error) {
    report.refused.push(action + ": " + error.message);
  }
}
const question = (await engine.feed()).find((entry) => entry.input?.status === "open");
report.question = question?.title;
await engine.answer(question.id, "yes");
await until(async () => (await stage(id)) === "awaiting-acceptance");
const task = await tasks.get(id);
report.done = stateOf(task);
report.status = task.status;
report.runs = (await engine.runs()).filter((run) => run.step === "task-pipeline-attempt").map((run) => ({ id: run.id, status: run.status }));`
  );
  const resumed = run(resume, ask);
  expect(resumed.reconciled).toEqual([]);
  expect(resumed.afterReconcile).toMatchObject({
    attempt: { parked: expect.any(String), runId },
    stage: "running",
  });
  const refusals = resumed.refused as string[];
  expect(refusals.map((line) => line.split(":")[0])).toEqual([
    "retry",
    "reroute",
    "refine",
    "accept",
  ]);
  for (const line of refusals) {
    expect(line).toContain("parked on a question");
  }
  expect(resumed.question).toBe("Go on?");
  const done = resumed.done as {
    attempt?: unknown;
    history: { runId?: string; stage: string }[];
    outcome: { output: string; runId: string };
  };
  // The same run finished it: one entry per process, one effect in all.
  expect(done.outcome).toMatchObject({ output: '{"done":true}', runId });
  expect(done.attempt).toBeUndefined();
  expect(done.history.at(-1)).toMatchObject({
    runId,
    stage: "awaiting-acceptance",
  });
  expect(resumed.status).toBe("active");
  expect(resumed.runs).toEqual([{ id: runId, status: "complete" }]);
  expect(lines(root, "runs.log")).toHaveLength(1);
  expect(lines(root, "answers.log")).toEqual(['"yes"']);
  expect(lines(root, "router.log")).toHaveLength(1);
  expect(lines(root, "refiner.log")).toHaveLength(1);

  // 3. Replaying every change to a fresh handler launches nothing more.
  const replayed = JSON.parse(readFileSync(records, "utf8"));
  for (const item of replayed.items) {
    item.delivered = [];
  }
  writeFileSync(records, JSON.stringify(replayed));
  const replay = phase(
    root,
    "replay",
    `await until(async () => {
  const file = JSON.parse(await Bun.file(${JSON.stringify(records)}).text());
  return file.items.every((item) => item.delivered.length === 1);
});
await new Promise((done) => setTimeout(done, 500));
report.stage = await stage(${JSON.stringify(taskId)});`
  );
  expect(run(replay, ask).stage).toBe("awaiting-acceptance");
  expect(lines(root, "runs.log")).toHaveLength(1);
  expect(lines(root, "router.log")).toHaveLength(1);
}, 180_000);

it("interrupts a parked run that resumed and then crashed: its new host owned it, and nothing can adopt it now", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-pipeline-resumed-"));
  roots.push(root);
  const ask = { MARBLES_TEST_ASK: "1" };
  const park = phase(
    root,
    "park",
    `const task = await tasks.create({ tags: ["pipeline"], title: "Ask, then crash" });
report.taskId = task.id;
await until(async () => stateOf(await tasks.get(task.id))?.attempt?.parked !== undefined);
await until(async () => (await engine.runs()).some((run) => run.status === "suspended"));
await engine.stop({ cancel: true });`
  );
  const taskId = run(park, ask).taskId as string;

  // Answered in a second process, which crashes inside the resumed run.
  const resume = phase(
    root,
    "resume",
    `const question = (await engine.feed()).find((entry) => entry.input?.status === "open");
await engine.answer(question.id, "yes");
await new Promise(() => undefined);`
  );
  let killed: unknown;
  try {
    run(resume, { ...ask, MARBLES_TEST_CRASH: "1" });
  } catch (error) {
    killed = (error as { signal?: string }).signal;
  }
  expect(killed).toBe("SIGKILL");
  expect(lines(root, "answers.log")).toEqual(['"yes"']);
  const crashed = JSON.parse(
    readFileSync(join(root, "state", "tasks.json"), "utf8")
  ).tasks.find((task: { id: string }) => task.id === taskId).metadata.pipeline;
  // The resumed run took the attempt over: no longer parked, a new owner.
  expect(crashed.stage).toBe("running");
  expect(crashed.attempt.parked).toBeUndefined();

  // A third process interrupts it, and a retry is accepted.
  const restart = phase(
    root,
    "restart",
    `const id = ${JSON.stringify(taskId)};
report.reconciled = (await pipeline.reconcile.run()).interrupted;
report.stage = await stage(id);
report.retry = (await pipeline.request.run({ action: "retry", taskId: id })).stage;`
  );
  const restarted = run(restart, ask);
  expect([[], [taskId]]).toContainEqual(restarted.reconciled);
  expect(restarted.stage).toBe("interrupted");
  expect(restarted.retry).toBe("prepared");
}, 180_000);

it("keeps a refinement paused mid-turn across a restart: not interrupted, no retry beside it, finished by the same run once resumed", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-pipeline-paused-"));
  roots.push(root);

  // 1. The refiner's turn is held open; the step is paused from the host,
  // the way the dashboard pauses it, and the host stops gracefully.
  const pause = phase(
    root,
    "pause",
    `const task = await tasks.create({ tags: ["pipeline"], title: "Pause me" });
report.taskId = task.id;
await until(async () => Bun.file(${JSON.stringify(join(root, "refiner.log"))}).exists());
await until(async () => typeof stateOf(await tasks.get(task.id))?.attempt?.runId === "string");
const runId = stateOf(await tasks.get(task.id)).attempt.runId;
report.paused = engine.pause(runId, "task-pipeline-refine");
await until(async () => stateOf(await tasks.get(task.id))?.attempt?.parked !== undefined);
await until(async () => (await engine.runs()).some((run) => run.id === runId && run.status === "suspended"));
report.state = stateOf(await tasks.get(task.id));
await engine.stop({ cancel: true });`
  );
  const paused = run(pause, { MARBLES_TEST_HOLD_REFINE: "1" });
  const taskId = paused.taskId as string;
  const pausedState = paused.state as {
    attempt: { kind: string; parked: string; runId: string };
    stage: string;
  };
  expect(paused.paused).toBe(true);
  expect(pausedState.stage).toBe("refining");
  expect(pausedState.attempt).toMatchObject({
    kind: "refine",
    parked: expect.any(String),
  });
  const { runId } = pausedState.attempt;
  expect(
    JSON.parse(
      readFileSync(join(root, "state", "runs", `${runId}.json`), "utf8")
    ).run.status
  ).toBe("suspended");

  // 2. A new process adopts the paused run. Reconcile leaves it; a retry
  // beside it is refused; resuming it replays the refinement in the same
  // run, which goes on to route and run the destination once.
  const resume = phase(
    root,
    "resume",
    `const id = ${JSON.stringify(taskId)};
const runId = ${JSON.stringify(runId)};
report.reconciled = (await pipeline.reconcile.run()).interrupted;
report.afterReconcile = stateOf(await tasks.get(id));
try {
  await pipeline.request.run({ action: "refine", taskId: id });
  report.refused = "accepted";
} catch (error) {
  report.refused = error.message;
}
report.adopted = (await engine.runs()).find((run) => run.id === runId)?.status;
await engine.resume(runId, "task-pipeline-refine");
await until(async () => (await stage(id)) === "awaiting-acceptance");
report.done = stateOf(await tasks.get(id));
report.refines = (await engine.runs()).filter((run) => run.step === "task-pipeline-refine").map((run) => ({ id: run.id, status: run.status }));`
  );
  const resumed = run(resume);
  expect(resumed.reconciled).toEqual([]);
  expect(resumed.afterReconcile).toMatchObject({
    attempt: { parked: expect.any(String), runId },
    stage: "refining",
  });
  expect(resumed.refused).toContain("parked");
  expect(resumed.adopted).toBe("suspended");
  const done = resumed.done as {
    attempts: number;
    history: { runId?: string; stage: string }[];
  };
  expect(done.history.map((entry) => entry.stage)).toEqual([
    "intake",
    "prepared",
    "awaiting-acceptance",
  ]);
  expect(done.history[1]?.runId).toBe(runId);
  expect(done.attempts).toBe(2);
  expect(resumed.refines).toEqual([{ id: runId, status: "complete" }]);
  // Held once, replayed once; the router and destination ran once.
  expect(lines(root, "refiner.log")).toHaveLength(2);
  expect(lines(root, "router.log")).toHaveLength(1);
  expect(lines(root, "runs.log")).toHaveLength(1);
}, 180_000);

it("never puts back an older dropped state when an edited observer replays the history after a crash: the latest drop restores its failed run, and nothing runs again", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-pipeline-redrop-"));
  roots.push(root);
  const records = join(root, "state", "tasks.json");

  // 1. Prepared behind a dependency, the task's metadata is replaced and
  // put back. Its destination then fails after its effect, and a second
  // replacement drops the failed state; the host is killed just before
  // the observer's restore of it commits.
  const seed = phase(
    root,
    "seed",
    `const blocker = await tasks.create({ title: "Blocker" });
const task = await tasks.create({ tags: ["pipeline"], title: "Dropped twice" }, { dependsOn: [{ id: blocker.id }] });
log("task.id", task.id);
await until(async () => (await stage(task.id)) === "prepared");
await tasks.update(task.id, { metadata: { drop: 1 } });
await until(async () => (await stage(task.id)) === "prepared");
await tasks.complete(blocker.id);
await until(async () => (await stage(task.id)) === "failed");
log("failed.json", JSON.stringify(stateOf(await tasks.get(task.id))));
const change = tasks.change.bind(tasks);
tasks.change = async (batch) => {
  const restores = batch.operations.some((operation) => operation.kind === "task.update" && operation.patch.metadata?.pipeline?.stage !== undefined);
  if (restores) process.kill(process.pid, "SIGKILL");
  return change(batch);
};
await tasks.update(task.id, { metadata: { drop: 2 } });
await new Promise(() => undefined);`
  );
  let killed: unknown;
  try {
    run(seed, { MARBLES_TEST_FAIL: "1" });
  } catch (error) {
    killed = (error as { signal?: string }).signal;
  }
  expect(killed).toBe("SIGKILL");
  const [taskId] = lines(root, "task.id");
  const [failedLine] = lines(root, "failed.json");
  const failed = JSON.parse(failedLine ?? "{}");
  expect(failed.stage).toBe("failed");
  const seeded = JSON.parse(readFileSync(records, "utf8"));
  const dropped = seeded.tasks.find(
    (task: { id: string }) => task.id === taskId
  );
  expect(dropped.metadata).toEqual({ drop: 2 });
  const [oldHash] = seeded.items[0].delivered;
  expect(seeded.items.at(-1).delivered).toEqual([]);
  expect(lines(root, "runs.log")).toHaveLength(1);

  // 2. A new process whose observer was edited: every change is handed to
  // it again, oldest first, the first drop before the second.
  const replay = phase(
    root,
    "replay",
    `const id = ${JSON.stringify(taskId)};
await until(async () => {
  const file = JSON.parse(await Bun.file(${JSON.stringify(records)}).text());
  return file.items.every((item) => item.delivered.some((hash) => hash !== ${JSON.stringify(oldHash)}));
});
await new Promise((done) => setTimeout(done, 500));
const task = await tasks.get(id);
report.state = stateOf(task);
report.status = task.status;
report.metadata = task.metadata;`
  );
  const replayed = run(replay, { MARBLES_TEST_EDIT_OBSERVER: "1" });
  expect(replayed.state).toEqual(failed);
  expect(replayed.status).toBe("open");
  expect(replayed.metadata).toMatchObject({ drop: 2 });
  expect(lines(root, "entries.log")).toHaveLength(1);
  expect(lines(root, "runs.log")).toHaveLength(1);
  expect(lines(root, "router.log")).toHaveLength(1);
  expect(lines(root, "refiner.log")).toHaveLength(1);
}, 180_000);

it("keeps a drop it could not restore yet across a crash: the same observer restores the failed run after the restart, and untagging and tagging again runs nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-pipeline-behind-"));
  roots.push(root);
  const records = join(root, "state", "tasks.json");
  const isDrop = (item: {
    payload: { tasks: { after: { metadata: { drop?: number } } | null }[] };
  }) => item.payload.tasks.some((delta) => delta.after?.metadata.drop === 2);

  // 1. The destination fails after its effect. A replacement then drops the
  // failed state, and the task is renamed before the observer handles the
  // drop; the host is killed once that drop is recorded as delivered.
  const seed = phase(
    root,
    "seed",
    `const task = await tasks.create({ tags: ["pipeline"], title: "Dropped behind a rename" });
log("task.id", task.id);
await until(async () => (await stage(task.id)) === "failed");
log("failed.json", JSON.stringify(stateOf(await tasks.get(task.id))));
await tasks.update(task.id, { metadata: { drop: 2 } });
await until(async () => {
  const file = JSON.parse(await Bun.file(${JSON.stringify(records)}).text());
  const drop = file.items.find((item) => item.payload.tasks.some((delta) => delta.after?.metadata.drop === 2));
  return drop.delivered.length === 1;
});
process.kill(process.pid, "SIGKILL");`
  );
  let killed: unknown;
  try {
    run(seed, { MARBLES_TEST_FAIL: "1", MARBLES_TEST_RENAME_FIRST: "seed" });
  } catch (error) {
    killed = (error as { signal?: string }).signal;
  }
  expect(killed).toBe("SIGKILL");
  const [taskId] = lines(root, "task.id");
  const failed = JSON.parse(lines(root, "failed.json")[0] ?? "{}");
  expect(failed.stage).toBe("failed");
  const seeded = JSON.parse(readFileSync(records, "utf8"));
  const stopped = seeded.tasks.find(
    (task: { id: string }) => task.id === taskId
  );
  // The drop was acknowledged only after what it owes was on the task.
  expect(stopped.title).toBe("Renamed");
  expect(stopped.metadata.drop).toBe(2);
  expect(stopped.metadata.pipeline.stage).toBeUndefined();
  expect(stopped.metadata.pipeline.pending.image).toEqual(failed);
  const drops = seeded.items.filter(isDrop);
  const [hash] = seeded.items[0].delivered;
  expect(drops[0].delivered).toEqual([hash]);
  expect(drops[1].payload.tasks[0].after.title).toBe("Renamed");
  expect(drops[1].delivered).toEqual([]);
  expect(lines(root, "runs.log")).toHaveLength(1);

  // 2. The same observer in a new process gets the rest, in order.
  const restart = phase(
    root,
    "restart",
    `const id = ${JSON.stringify(taskId)};
const delivered = async () => {
  const file = JSON.parse(await Bun.file(${JSON.stringify(records)}).text());
  return file.items.every((item) => item.delivered.length === 1);
};
const settle = async () => {
  await until(delivered);
  await new Promise((done) => setTimeout(done, 500));
  await until(delivered);
};
await settle();
let task = await tasks.get(id);
report.restored = stateOf(task) ?? null;
report.title = task.title;
report.status = task.status;
await tasks.update(id, { tags: [] });
await tasks.update(id, { tags: ["pipeline"] });
await settle();
task = await tasks.get(id);
report.retagged = stateOf(task) ?? null;
report.retaggedStatus = task.status;
const file = JSON.parse(await Bun.file(${JSON.stringify(records)}).text());
report.hashes = [...new Set(file.items.flatMap((item) => item.delivered))];`
  );
  const restarted = run(restart, {
    MARBLES_TEST_FAIL: "1",
    MARBLES_TEST_RENAME_FIRST: "restart",
  });
  expect(restarted.restored).toEqual(failed);
  expect(restarted.title).toBe("Renamed");
  expect(restarted.status).toBe("open");
  expect(restarted.retagged).toEqual(failed);
  expect(restarted.retaggedStatus).toBe("open");
  expect(restarted.hashes).toEqual([hash]);
  expect(lines(root, "entries.log")).toHaveLength(1);
  expect(lines(root, "runs.log")).toHaveLength(1);
  expect(lines(root, "router.log")).toHaveLength(1);
  expect(lines(root, "refiner.log")).toHaveLength(1);
}, 180_000);

it("keeps the latest dropped state across a crash while the observer's writes for its giving and its drop keep failing: the same or an edited observer restores that failed run, and nothing runs again", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-pipeline-refail-"));
  roots.push(root);
  const records = join(root, "state", "tasks.json");

  // 1. The destination fails after its effect. A user then writes a retry
  // state (which would run again if put back), drops it, gives the failed
  // state back, and drops that, all before the observer handles any of it.
  // Its writes for the giving and for the second drop always fail here; the
  // host is killed once it has failed on them.
  const seed = phase(
    root,
    "seed",
    `const task = await tasks.create({ tags: ["pipeline"], title: "Given back and dropped" });
log("task.id", task.id);
await until(async () => (await stage(task.id)) === "failed");
const failed = stateOf(await tasks.get(task.id));
log("failed.json", JSON.stringify(failed));
await until(async () => {
  const file = JSON.parse(await Bun.file(${JSON.stringify(records)}).text());
  return file.items.every((item) => item.delivered.length === 1);
});
await new Promise((done) => setTimeout(done, 300));
const older = request(failed, await tasks.get(task.id), { action: "retry" }, new Date().toISOString());
log("older.json", JSON.stringify(older));
let release = () => undefined;
const released = new Promise((done) => { release = done; });
const listing = { armed: true, held: false };
const list = tasks.list.bind(tasks);
tasks.list = async (query) => {
  if (listing.armed) {
    listing.armed = false;
    listing.held = true;
    await released;
  }
  return list(query);
};
const change = tasks.change.bind(tasks);
tasks.change = async (batch) => {
  for (const operation of batch.operations) {
    const pending = operation.kind === "task.update" ? operation.patch.metadata?.pipeline?.pending : undefined;
    if (pending !== undefined && (pending.image === undefined || pending.image.stage === "failed")) {
      log("failures.log", pending.image === undefined ? "superseded" : "owed");
      throw new Error("the disk hiccuped");
    }
  }
  return change(batch);
};
await tasks.update(task.id, { metadata: { pipeline: older } });
await until(async () => listing.held);
await tasks.update(task.id, { metadata: { drop: 1 } });
await tasks.update(task.id, { metadata: { pipeline: failed } });
await tasks.update(task.id, { metadata: { drop: 2 } });
release();
await until(async () => (await Bun.file(${JSON.stringify(join(root, "failures.log"))}).exists()));
await new Promise((done) => setTimeout(done, 500));
process.kill(process.pid, "SIGKILL");`
  );
  let killed: unknown;
  try {
    run(seed, { MARBLES_TEST_FAIL: "1" });
  } catch (error) {
    killed = (error as { signal?: string }).signal;
  }
  expect(killed).toBe("SIGKILL");
  const [taskId] = lines(root, "task.id");
  const failed = JSON.parse(lines(root, "failed.json")[0] ?? "{}");
  const older = JSON.parse(lines(root, "older.json")[0] ?? "{}");
  expect(failed.stage).toBe("failed");
  expect(failed.outcome.runId).toEqual(expect.any(String));
  expect(older.stage).toBe("prepared");
  // The observer never got past the change it kept failing on, so the
  // older retry state was never put back and nothing ran again.
  expect(lines(root, "failures.log")).toContain("superseded");
  expect(lines(root, "entries.log")).toHaveLength(1);
  const seeded = JSON.parse(readFileSync(records, "utf8"));
  const stopped = seeded.tasks.find(
    (task: { id: string }) => task.id === taskId
  );
  expect(stopped.metadata.drop).toBe(2);
  expect(stopped.metadata.pipeline.stage).toBeUndefined();
  expect(stopped.metadata.pipeline.pending.image).toEqual(older);
  const [oldHash] = seeded.items[0].delivered;
  expect(
    seeded.items.filter(
      (item: { delivered: string[] }) => item.delivered.length === 0
    ).length
  ).toBeGreaterThanOrEqual(3);

  // 2. From that crash, once with the same observer and once, over a copy,
  // with an edited one that is handed the whole history again. Then the
  // task is untagged and tagged again.
  const copy = await mkdtemp(join(tmpdir(), "marbles-pipeline-refail-edit-"));
  roots.push(copy);
  await cp(root, copy, { recursive: true });
  const restartIn = (dir: string, done: string) =>
    phase(
      dir,
      "restart",
      `const id = ${JSON.stringify(taskId)};
const delivered = async () => {
  const file = JSON.parse(await Bun.file(${JSON.stringify(join(dir, "state", "tasks.json"))}).text());
  return file.items.every((item) => ${done});
};
const settle = async () => {
  await until(delivered);
  await new Promise((done) => setTimeout(done, 500));
  await until(delivered);
};
await settle();
let task = await tasks.get(id);
report.restored = stateOf(task) ?? null;
report.status = task.status;
report.drop = task.metadata.drop;
await tasks.update(id, { tags: [] });
await tasks.update(id, { tags: ["pipeline"] });
await settle();
task = await tasks.get(id);
report.retagged = stateOf(task) ?? null;
report.retaggedStatus = task.status;`
    );
  const same = run(restartIn(root, "item.delivered.length === 1"), {
    MARBLES_TEST_FAIL: "1",
  });
  const edited = run(
    restartIn(
      copy,
      `item.delivered.some((hash) => hash !== ${JSON.stringify(oldHash)})`
    ),
    { MARBLES_TEST_EDIT_OBSERVER: "1", MARBLES_TEST_FAIL: "1" }
  );
  for (const [dir, restarted] of [
    [root, same],
    [copy, edited],
  ] as const) {
    expect(restarted.restored).toEqual(failed);
    expect(restarted.status).toBe("open");
    expect(restarted.drop).toBe(2);
    expect(restarted.retagged).toEqual(failed);
    expect(restarted.retaggedStatus).toBe("open");
    expect(lines(dir, "entries.log")).toHaveLength(1);
    expect(lines(dir, "runs.log")).toHaveLength(1);
    expect(lines(dir, "router.log")).toHaveLength(1);
    expect(lines(dir, "refiner.log")).toHaveLength(1);
  }
}, 240_000);
