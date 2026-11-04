/**
 * Execution Runs through the real engine: named FIFO queues with their own
 * live concurrency and no capacity limit, records written when a run is
 * queued and at each change after, recovery of what an exited process left,
 * the lifecycle subscription, and host tasks that outlive their slot.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStore } from "@foundry/agents/session";
import type { Container } from "@foundry/sandbox/container/containers";
import type { Factory } from "@foundry/workflows/orchestrator";
import { Step } from "@foundry/workflows/step";
import { Workflow } from "@foundry/workflows/workflow";
import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { step } from "~/authoring/builder";
import { catalog } from "~/authoring/catalog";
import type { Engine } from "~/lib/engine";
import { type ExecutionRun, Executions } from "~/lib/executions";
import { JsonSessionStore } from "~/lib/sessions/json-store";
import { JsonStateStore } from "~/lib/state/store";
import type { TaskContext } from "~/lib/tasks";
import { dashboardSnapshot } from "~/workspace/snapshot";
import { testEngine } from "../helpers/engine";

let root: string;
const engines: Engine[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marbles-executions-"));
});

afterEach(async () => {
  catalog.reset();
  await Promise.allSettled(engines.splice(0).map((engine) => engine.dispose()));
  await rm(root, { force: true, recursive: true });
});

function gate() {
  const { promise: opened, resolve: open } = Promise.withResolvers<void>();
  return { open: () => open(), opened };
}

/** An engine, tracked so every test disposes what it opened. */
function engineWith(options: Parameters<typeof testEngine>[0] = {}): Engine {
  const engine = testEngine({ root, ...options });
  engines.push(engine);
  return engine;
}

/** Resolves once `check` holds, polling briefly. */
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A task that records when it starts and waits for its gate. */
function blockingTask(
  engine: Engine,
  name: string,
  started: string[],
  gates: Map<string, () => void>,
  queue?: string
): void {
  engine.task<{ label: string }, string>({
    name,
    ...(queue === undefined ? {} : { queue }),
    run: async ({ label }, { signal }) => {
      started.push(label);
      const { open, opened } = gate();
      gates.set(label, open);
      signal.addEventListener("abort", open, { once: true });
      await opened;
      return label;
    },
  });
}

/** A pid that has certainly exited. */
function exitedPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  if (pid === undefined) {
    throw new Error("could not spawn");
  }
  return pid;
}

it("admits a queue in FIFO order, one at a time by default", async () => {
  const engine = engineWith();
  const order: number[] = [];
  engine.task<number, number>({
    name: "note",
    run: async (n) => {
      order.push(n);
      await new Promise((resolve) => setTimeout(resolve, 1));
      return n;
    },
  });
  await engine.start();
  const launched = await Promise.all(
    [1, 2, 3, 4, 5].map((n) => engine.launch<number>("note", n))
  );
  expect(await Promise.all(launched.map((run) => run.result))).toEqual([
    1, 2, 3, 4, 5,
  ]);
  expect(order).toEqual([1, 2, 3, 4, 5]);
  expect(engine.executions.list().map((run) => run.status)).toEqual(
    new Array(5).fill("complete")
  );
  expect(engine.executions.list().map((run) => run.queue)).toEqual(
    new Array(5).fill("marbles")
  );
});

it.each(["anonymous", "registered"] as const)(
  "direct calls to a %s definition share queue admission and durable records",
  async (kind) => {
    const started: number[] = [];
    const release = gate();
    const definition = (kind === "registered" ? step("direct") : step())
      .input(z.object({ n: z.number() }))
      .do(async ({ input }) => {
        started.push(input.n);
        await release.opened;
        return input.n;
      });
    const state = join(root, "state");
    const engine = engineWith({ state });
    const store = new JsonStateStore(state);
    const first = engine.execute<number>(definition, { n: 1 });
    const second = engine.execute<number>(definition, { n: 2 });
    try {
      await until(() => started.length === 1);
      const records = engine.executions.list();
      expect(records).toHaveLength(2);
      expect(new Set(records.map((run) => run.name)).size).toBe(1);
      if (kind === "registered") {
        expect(records[0]?.name).toBe("direct");
      }
      expect(records.map((run) => run.status).sort()).toEqual([
        "queued",
        "running",
      ]);
      expect(started).toEqual([1]);
      expect(records.every((run) => run.queue === "marbles")).toBe(true);
      for (const record of records) {
        expect(store.read("executions", record.id)).toMatchObject({
          name: record.name,
          status: record.status,
        });
      }
    } finally {
      release.open();
      await Promise.allSettled([first, second]);
    }
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(started).toEqual([1, 2]);
    expect(engine.executions.list().map((run) => run.status)).toEqual([
      "complete",
      "complete",
    ]);
  }
);

it("never refuses a run for capacity: a deep system backlog is all admitted in order", async () => {
  const engine = engineWith({ queues: { system: { concurrency: 1 } } });
  const order: number[] = [];
  engine.task<number, number>({
    name: "save",
    queue: "system",
    run: (n) => {
      order.push(n);
      return n;
    },
  });
  await engine.start();
  const count = 500;
  const launched = await Promise.all(
    Array.from({ length: count }, (_, n) => engine.launch<number>("save", n))
  );
  await Promise.all(launched.map((run) => run.result));
  expect(order).toEqual(Array.from({ length: count }, (_, n) => n));
  expect(
    engine.executions.list().every((run) => run.status === "complete")
  ).toBe(true);
});

it("bounds each queue by its own concurrency, and one queue's backlog never holds another", async () => {
  const engine = engineWith({
    queues: { authoring: { concurrency: 2 }, workflows: { concurrency: 1 } },
  });
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  blockingTask(engine, "turn", started, gates, "authoring");
  blockingTask(engine, "flow", started, gates, "workflows");
  await engine.start();

  const flows = await Promise.all(
    ["f1", "f2", "f3"].map((label) => engine.launch("flow", { label }))
  );
  const turns = await Promise.all(
    ["t1", "t2", "t3"].map((label) => engine.launch("turn", { label }))
  );
  await until(() => started.length === 3);
  expect(started).toEqual(["f1", "t1", "t2"]);
  expect(engine.executions.queues()).toEqual(
    expect.arrayContaining([
      { active: 2, concurrency: 2, name: "authoring", waiting: 1 },
      { active: 1, concurrency: 1, name: "workflows", waiting: 2 },
    ])
  );

  gates.get("t1")?.();
  await until(() => started.includes("t3"));
  expect(started).not.toContain("f2");

  for (const label of ["f1", "t2", "t3"]) {
    gates.get(label)?.();
  }
  await until(() => started.includes("f2"));
  gates.get("f2")?.();
  await until(() => started.includes("f3"));
  gates.get("f3")?.();
  await Promise.all([...flows, ...turns].map((run) => run.result));
});

it("applies a concurrency change live, without stopping what already runs", async () => {
  const engine = engineWith();
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  blockingTask(engine, "work", started, gates, "module:a:authoring");
  await engine.start();
  const runs = await Promise.all(
    ["a", "b", "c", "d"].map((label) => engine.launch("work", { label }))
  );
  await until(() => started.length === 1);

  engine.executions.configure("module:a:authoring", { concurrency: 3 });
  await until(() => started.length === 3);
  expect(started).toEqual(["a", "b", "c"]);

  engine.executions.configure("module:a:authoring", { concurrency: 1 });
  gates.get("a")?.();
  gates.get("b")?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(started).toEqual(["a", "b", "c"]);
  gates.get("c")?.();
  await until(() => started.length === 4);
  gates.get("d")?.();
  await Promise.all(runs.map((run) => run.result));
  expect(() => engine.executions.configure("x", { concurrency: 0 })).toThrow(
    "positive integer"
  );
});

it("writes a run when it is queued, before it starts, and when it settles", async () => {
  const state = join(root, "state");
  const engine = engineWith({ state });
  const store = new JsonStateStore(state);
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  blockingTask(engine, "build", started, gates);
  await engine.start();

  const first = await engine.launch(
    "build",
    { label: "one" },
    {
      correlation: { moduleId: "notes" },
    }
  );
  const second = await engine.launch("build", { label: "two" });
  await until(() => started.length === 1);

  const stored = (id: string) => store.read("executions", id) as ExecutionRun;
  expect(stored(first.id)).toMatchObject({
    correlation: { moduleId: "notes" },
    kind: "task",
    name: "build",
    owner: { pid: process.pid },
    queue: "marbles",
    status: "running",
  });
  expect(stored(first.id).input).toBeUndefined();
  expect(stored(first.id).timestamps.startedAt).toBeDefined();
  expect(stored(second.id)).toMatchObject({
    input: { label: "two" },
    status: "queued",
  });

  gates.get("one")?.();
  await first.result;
  expect(stored(first.id)).toMatchObject({ status: "complete" });
  expect(stored(first.id).timestamps.settledAt).toBeDefined();
  await until(() => started.length === 2);
  gates.get("two")?.();
  await second.result;
  expect(stored(second.id).status).toBe("complete");
});

it("records workflow runs under the Orchestrator's own id, and shows queued ones on the dashboard", async () => {
  const release = gate();
  step("hold").do(async () => {
    await release.opened;
    return "held";
  });
  const engine = engineWith();
  await engine.start();
  const first = await engine.launch<string>("hold", {}, "watch");
  const second = await engine.launch<string>("hold", {}, "other");

  expect(engine.executions.get(first.id)).toMatchObject({
    correlation: { triggerId: "watch" },
    kind: "workflow",
    status: "running",
  });
  expect(engine.executions.get(second.id)?.status).toBe("queued");
  const runIds = (await engine.runs()).map((run) => run.id);
  expect(runIds).toEqual([first.id]);

  const snapshot = dashboardSnapshot(await engine.runs(), {
    definitions: engine.definitions(),
    lastFinish: new Map(),
    monitors: new Map(),
    queued: engine.executions.list(),
    root,
    schedules: [],
    startedAt: Date.now(),
    status: "test",
  });
  expect(snapshot.runs.map((run) => run.id)).toEqual([second.id, first.id]);
  expect(snapshot.runs[0]).toMatchObject({
    name: "hold",
    status: "queued",
    steps: [],
    triggerId: "other",
  });

  release.open();
  expect(await first.result).toBe("held");
  expect(await second.result).toBe("held");
  expect(engine.executions.get(first.id)).toMatchObject({
    progress: { event: "step.complete", step: "hold" },
    status: "complete",
  });
});

it("cancels a queued run without starting it", async () => {
  const engine = engineWith();
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  blockingTask(engine, "work", started, gates);
  await engine.start();
  const first = await engine.launch("work", { label: "a" });
  const second = await engine.launch("work", { label: "b" });
  await engine.cancel(second.id);
  await expect(second.result).rejects.toThrow("cancelled before it started");
  gates.get("a")?.();
  await first.result;
  expect(started).toEqual(["a"]);
  expect(engine.executions.get(second.id)?.status).toBe("cancelled");
});

it("cancels a workflow run whose dispatch is still in flight", async () => {
  const dispatch = gate();
  let ran = false;
  class Record extends Step<string, string> {
    readonly definitionKey = "test.record";

    protected execute(input: string): Promise<string> {
      ran = true;
      return Promise.resolve(input);
    }
  }
  const engine = engineWith();
  // Its factory resolves only when let through: the run is recorded running
  // while the Orchestrator has not stored it yet.
  const factory = new Record().factory();
  engine.register<string, string>("slow", async (input, context) => {
    await dispatch.opened;
    return factory(input, context);
  });
  await engine.start();
  const launching = engine.launch<string>("slow", "x");
  await until(() =>
    engine.executions.list().some((run) => run.status === "running")
  );
  const [running] = engine.executions.list();
  const cancelled = engine.cancel(running?.id ?? "");
  dispatch.open();
  const launched = await launching;
  await cancelled;
  await expect(launched.result).rejects.toThrow("cancelled");
  expect(engine.executions.get(launched.id)?.status).toBe("cancelled");
  expect(ran).toBe(false);
});

it("leaves a settled task as it is when it is cancelled", async () => {
  const engine = engineWith();
  engine.task({ name: "save", run: () => "saved" });
  await engine.start();
  const launched = await engine.launch("save", {});
  await launched.result;
  await expect(engine.cancel(launched.id)).resolves.toBeUndefined();
  expect(engine.executions.get(launched.id)?.status).toBe("complete");
});

it("never changes a settled run: late progress, parks, resumes and observations are dropped", async () => {
  const executions = new Executions({
    store: new JsonStateStore(join(root, "state")),
    warn: () => undefined,
  });
  const { run } = executions.enqueue({
    correlation: {},
    kind: "task",
    name: "save",
    queue: "system",
  });
  await executions.admit(
    run.id,
    () => Promise.resolve(),
    () => undefined
  );
  executions.settle(run.id, "complete");
  const settled = executions.get(run.id);

  executions.progress(run.id, { late: true });
  executions.suspend(run.id);
  executions.resume(run.id);
  const observed = executions.observe(run.id, {
    id: "late",
    kind: "effect",
    startedAt: new Date().toISOString(),
    status: "complete",
    type: "gateway",
  });

  expect(observed).toBe(false);
  expect(executions.get(run.id)).toEqual(settled);
  expect(executions.queues()).toEqual([
    { active: 0, concurrency: 1, name: "system", waiting: 0 },
  ]);
});

it("returns the run a source already started instead of launching it twice", async () => {
  const engine = engineWith();
  let calls = 0;
  engine.task({
    name: "save",
    run: () => {
      calls += 1;
      return "saved";
    },
  });
  await engine.start();
  const first = await engine.launch("save", {}, { source: "save:notes:1" });
  const again = await engine.launch("save", {}, { source: "save:notes:1" });
  expect(again.id).toBe(first.id);
  expect(await first.result).toBe("saved");
  expect(calls).toBe(1);
  expect(engine.executions.list()).toHaveLength(1);
});

it("returns a source's run only to a launch of the same name", async () => {
  const engine = engineWith();
  engine.task({ name: "save", run: () => "saved" });
  engine.task({ name: "publish", run: () => "published" });
  await engine.start();
  const saved = await engine.launch("save", {}, { source: "notes:1" });
  const published = await engine.launch("publish", {}, { source: "notes:1" });
  expect(published.id).not.toBe(saved.id);
  expect(await published.result).toBe("published");
});

it("keeps a failure's message off the record when its launch says so, and hands the caller the error", async () => {
  const engine = engineWith();
  const failure = Object.assign(new Error("401 key sk-planted-1"), {
    name: "APICallError",
    statusCode: 401,
  });
  engine.task({
    name: "turn",
    run: () => Promise.reject(failure),
  });
  await engine.start();
  const launched = await engine.launch(
    "turn",
    {},
    { recordErrorMessage: false }
  );
  await expect(launched.result).rejects.toBe(failure);
  expect(engine.executions.get(launched.id)).toMatchObject({
    error: { code: "APICallError:401" },
    status: "failed",
  });
  expect(engine.executions.get(launched.id)?.error).not.toHaveProperty(
    "message"
  );
});

it("logs a running run's observations one at a time, folds them into its settled record, and keeps them across a crash", async () => {
  const state = join(root, "state");
  const store = new JsonStateStore(state);
  const log = (id: string) => join(state, "observations", `${id}.jsonl`);
  const engine = engineWith({ state });
  const hold = gate();
  engine.task({
    name: "program",
    run: async (_input, { observe }: TaskContext) => {
      for (const id of ["call-0", "call-1", "call-2"]) {
        observe({ id, kind: "effect", status: "running", type: "gateway" });
      }
      observe({ id: "call-1", kind: "effect", type: "gateway" });
      await hold.opened;
    },
  });
  await engine.start();
  const launched = await engine.launch("program", {});
  await until(() => store.log("observations", launched.id).length === 4);

  // Observing never rewrote the record: it was last written when it started.
  const record = store.read("executions", launched.id) as ExecutionRun;
  expect(record).toMatchObject({ revision: 2, status: "running" });
  expect(record).not.toHaveProperty("observations");
  const entries = store.log("observations", launched.id);
  const live = engine.executions.get(launched.id);
  expect(live?.observations.map(({ id, status }) => `${id}:${status}`)).toEqual(
    ["call-0:running", "call-2:running", "call-1:complete"]
  );

  hold.open();
  await launched.result;
  const settled = store.read("executions", launched.id) as ExecutionRun;
  expect(settled.status).toBe("complete");
  expect(settled.observations).toEqual(
    engine.executions.get(launched.id)?.observations
  );
  expect(existsSync(log(launched.id))).toBe(false);
  await engine.dispose();

  // As a crash while it ran leaves it: the record as it started, and its log.
  const dead = exitedPid();
  store.remove("executions", launched.id);
  store.write("executions", launched.id, { ...record, owner: { pid: dead } });
  for (const entry of entries) {
    store.append("observations", launched.id, entry as Record<string, unknown>);
  }
  const next = engineWith({ state });
  await next.start();
  const recovered = next.executions.get(launched.id);
  expect(recovered).toMatchObject({ status: "interrupted" });
  expect(recovered?.observations).toEqual(live?.observations);
  expect(recovered?.revision).toBeGreaterThan(live?.revision ?? 0);
  expect(existsSync(log(launched.id))).toBe(false);
});

it("aborts exec through a lent container when its task is cancelled", async () => {
  const signals: (AbortSignal | undefined)[] = [];
  const container = {
    commands: {
      exec: (_argv: string[], options: { signal?: AbortSignal }) => {
        signals.push(options.signal);
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
      },
    },
    id: "host-owned",
  } as unknown as Container;
  const engine = engineWith();
  const entered = gate();
  engine.task({
    name: "build",
    run: async (_input, { sandbox, signal }: TaskContext) => {
      await sandbox(container).exec(["true"]);
      entered.open();
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true })
      );
    },
  });
  await engine.start();
  const launched = await engine.launch("build", {});
  await entered.opened;
  expect(signals[0]?.aborted).toBe(false);
  await engine.cancel(launched.id);
  expect(signals[0]?.aborted).toBe(true);
});

/** Records as a crashed process would have left them. */
function leftBehind(
  state: string,
  pid: number,
  runs: readonly Partial<ExecutionRun>[]
): void {
  const store = new JsonStateStore(state);
  for (const [index, run] of runs.entries()) {
    const at = new Date(Date.now() - 1000 + index).toISOString();
    store.write("executions", run.id ?? `rn-left-${index}`, {
      correlation: {},
      id: `rn-left-${index}`,
      kind: "task",
      name: "save",
      observations: [],
      owner: { pid },
      queue: "system",
      revision: 2,
      sequence: 1000 + index,
      status: "queued",
      timestamps: { queuedAt: at, updatedAt: at },
      ...run,
    });
  }
}

it("marks what an exited process was running interrupted, and admits its queue again in order", async () => {
  const state = join(root, "state");
  const dead = exitedPid();
  leftBehind(state, dead, [
    { id: "rn-program", name: "program", queue: "programs", status: "running" },
    { id: "rn-save-1", input: { n: 1 } },
    { id: "rn-save-2", input: { n: 2 } },
    { id: "rn-save-3", input: { n: 3 } },
  ]);
  // A live process's work is its own.
  leftBehind(state, process.ppid, [
    { id: "rn-live", input: { n: 9 }, sequence: 1 },
  ]);

  const order: number[] = [];
  const engine = engineWith({ recoverQueued: true, state });
  engine.task<{ n: number }, number>({
    name: "save",
    queue: "system",
    run: ({ n }) => {
      order.push(n);
      return n;
    },
  });
  engine.task({ name: "program", queue: "programs", run: () => undefined });
  await engine.start();
  // A run launched after start waits behind what was recovered.
  const later = await engine.launch<number>("save", { n: 4 });
  await later.result;

  expect(order).toEqual([1, 2, 3, 4]);
  expect(engine.executions.get("rn-program")).toMatchObject({
    error: { code: "interrupted" },
    owner: { pid: process.pid },
    status: "interrupted",
  });
  expect(engine.executions.get("rn-live")).toMatchObject({
    owner: { pid: process.ppid },
    status: "queued",
  });
  const store = new JsonStateStore(state);
  expect(store.read("executions", "rn-save-3")).toMatchObject({
    status: "complete",
  });
  expect(store.read("executions", "rn-program")).toMatchObject({
    status: "interrupted",
  });
});

it("leaves an exited process's queue queued and visible unless asked to recover it", async () => {
  const state = join(root, "state");
  leftBehind(state, exitedPid(), [{ id: "rn-save-1", input: { n: 1 } }]);
  let calls = 0;
  const engine = engineWith({ state });
  engine.task({
    name: "save",
    run: () => {
      calls += 1;
    },
  });
  await engine.start();
  expect(engine.executions.get("rn-save-1")?.status).toBe("queued");
  await engine.cancel("rn-save-1");
  expect(engine.executions.get("rn-save-1")?.status).toBe("cancelled");
  expect(calls).toBe(0);
});

it("keeps queued work across a stop and admits it in the next process's order", async () => {
  const state = join(root, "state");
  const first = engineWith({ state });
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  blockingTask(first, "save", started, gates, "system");
  await first.start();
  await first.launch("save", { label: "a" });
  const queued = await first.launch("save", { label: "b" });
  const after = await first.launch("save", { label: "c" });
  await until(() => started.length === 1);
  // As a crash would leave them: the queued records on disk, owned by a dead pid.
  const store = new JsonStateStore(state);
  const left = [queued.id, after.id].map(
    (id) => store.read("executions", id) as ExecutionRun
  );
  await first.dispose();
  const dead = exitedPid();
  for (const record of left) {
    store.write("executions", record.id, { ...record, owner: { pid: dead } });
  }

  const second = engineWith({ recoverQueued: true, state });
  const resumed: string[] = [];
  second.task<{ label: string }, string>({
    name: "save",
    queue: "system",
    run: ({ label }) => {
      resumed.push(label);
      return label;
    },
  });
  await second.start();
  await until(() => second.executions.get(after.id)?.status === "complete");
  expect(resumed).toEqual(["b", "c"]);
  expect(started).toEqual(["a"]);
});

it("re-admits a queued workflow under its recorded id, and trusts a settled run file over a running record", async () => {
  const state = join(root, "state");
  const calls: string[] = [];
  step("flow").do(() => {
    calls.push("flow");
    return "ran";
  });
  const first = engineWith({ state });
  await first.start();
  const finished = await first.launch<string>("flow", {});
  await finished.result;
  await first.dispose();
  // As a crash between the run file and its record would leave them.
  const dead = exitedPid();
  const store = new JsonStateStore(state);
  const record = store.read("executions", finished.id) as ExecutionRun;
  store.write("executions", finished.id, {
    ...record,
    owner: { pid: dead },
    status: "running",
  });
  leftBehind(state, dead, [
    {
      id: "rn-flow-queued",
      input: {},
      kind: "workflow",
      name: "flow",
      queue: "marbles",
    },
  ]);

  const second = engineWith({ recoverQueued: true, state });
  await second.start();
  await until(
    () => second.executions.get("rn-flow-queued")?.status === "complete"
  );
  expect(second.executions.get(finished.id)?.status).toBe("complete");
  expect(calls).toEqual(["flow", "flow"]);
  expect((await second.runs()).map((run) => run.id)).toContain(
    "rn-flow-queued"
  );
});

it("prunes only settled runs, records the gap first, and drops a workflow's run file", async () => {
  const state = join(root, "state");
  step("flow").do(() => "ran");
  const engine = engineWith({ state });
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  blockingTask(engine, "hold", started, gates);
  await engine.start();
  const flow = await engine.launch<string>(
    "flow",
    {},
    { correlation: { moduleId: "a" } }
  );
  await flow.result;
  const held = await engine.launch<string>(
    "hold",
    { label: "held" },
    { correlation: { moduleId: "a" } }
  );
  await until(() => started.includes("held"));
  expect(existsSync(join(state, "runs", `${flow.id}.json`))).toBe(true);
  expect(existsSync(join(state, "output", `${flow.id}.jsonl`))).toBe(true);

  const removed = engine.executions.prune(
    [flow.id, held.id, "rn-unknown"],
    (run) => run.correlation.moduleId ?? "host"
  );
  // The running one is untouched; only the settled workflow went.
  expect(removed.map((run) => run.id)).toEqual([flow.id]);
  expect(engine.executions.get(flow.id)).toBeUndefined();
  expect(engine.executions.get(held.id)?.status).toBe("running");
  expect(existsSync(join(state, "executions", `${flow.id}.json`))).toBe(false);
  expect(existsSync(join(state, "runs", `${flow.id}.json`))).toBe(false);
  expect(existsSync(join(state, "output", `${flow.id}.jsonl`))).toBe(false);
  const [gap] = engine.executions.gaps();
  expect(gap).toMatchObject({ removed: 1, scope: "a" });
  expect(gap?.through).toBe(removed[0]?.timestamps.settledAt);
  gates.get("held")?.();
  await held.result;
  await engine.dispose();

  // The gap is durable: a later process reads it with the runs.
  const next = engineWith({ state });
  await next.start();
  expect(next.executions.gaps()).toEqual([gap]);
  expect(next.executions.get(flow.id)).toBeUndefined();
  expect(next.executions.get(held.id)?.status).toBe("complete");
});

it("subscribes with a snapshot and every change after, reconcilable by revision", async () => {
  const engine = engineWith();
  engine.task<number, number>({
    name: "step",
    run: (n, { observe, progress }) => {
      progress({ at: n });
      observe({ data: { bytes: n }, kind: "result", type: "save" });
      return n;
    },
  });
  await engine.start();
  await (await engine.launch("step", 1)).result;

  const seen = new Map<string, ExecutionRun>();
  const updates: ExecutionRun[] = [];
  const { snapshot, unsubscribe } = engine.executions.subscribe((run) => {
    updates.push(run);
  });
  for (const run of snapshot) {
    seen.set(run.id, run);
  }
  await (await engine.launch("step", 2)).result;
  await (await engine.launch("step", 3)).result;
  unsubscribe();
  await (await engine.launch("step", 4)).result;

  let duplicates = 0;
  for (const run of updates) {
    const known = seen.get(run.id);
    if (known && known.revision >= run.revision) {
      duplicates += 1;
      continue;
    }
    seen.set(run.id, run);
  }
  expect(duplicates).toBe(0);
  const statuses = updates.map(
    (run) => `${String(run.revision)}:${run.status}`
  );
  expect(statuses.slice(0, 2)).toEqual(["1:queued", "2:running"]);
  expect(seen.size).toBe(3);
  expect([...seen.values()].every((run) => run.status === "complete")).toBe(
    true
  );
  const latest = engine.executions.list();
  expect(latest).toHaveLength(4);
  expect(latest[1]).toEqual(seen.get(latest[1]?.id ?? ""));
  expect(latest[1]?.progress).toEqual({ at: 2 });
  expect(latest[1]?.observations).toEqual([
    expect.objectContaining({
      data: { bytes: 2 },
      kind: "result",
      status: "complete",
      type: "save",
    }),
  ]);
});

it("keeps a long-lived run running after it gives up its slot, until it is stopped", async () => {
  const state = join(root, "state");
  const engine = engineWith({ state });
  let stopped = false;
  engine.task({
    name: "program",
    queue: "system",
    run: async (_input, { release, signal }: TaskContext) => {
      release();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
      stopped = true;
    },
  });
  engine.task({ name: "save", queue: "system", run: () => "saved" });
  await engine.start();
  const program = await engine.launch(
    "program",
    {},
    {
      correlation: { kind: "program", moduleId: "notes" },
    }
  );
  // Later work on the queue is not held up by the program's lifetime.
  expect(await engine.run("save", {})).toBe("saved");
  expect(engine.executions.get(program.id)?.status).toBe("running");

  await engine.cancel(program.id);
  expect(stopped).toBe(true);
  await expect(program.result).rejects.toThrow("cancelled");
  expect(engine.executions.get(program.id)?.status).toBe("cancelled");

  // One left running is stopped with the engine.
  const another = await engine.launch("program", {});
  await engine.stop();
  await expect(another.result).rejects.toThrow();
  expect(engine.executions.get(another.id)?.status).toBe("cancelled");
});

it("fails a task that throws, with a safe code", async () => {
  const engine = engineWith();
  engine.task({
    name: "publish",
    run: () => {
      throw new TypeError("bad manifest");
    },
  });
  await engine.start();
  const launched = await engine.launch("publish", {});
  await expect(launched.result).rejects.toThrow("bad manifest");
  expect(engine.executions.get(launched.id)).toMatchObject({
    error: { code: "TypeError", message: "bad manifest" },
    status: "failed",
  });
});

it("rejects names it cannot run, and one name held by two kinds of runnable", async () => {
  step("taken").do(() => 1);
  const engine = engineWith();
  expect(() => engine.task({ name: "taken", run: () => 1 })).toThrow(
    "already registered"
  );
  // A raw factory may not take a task's name, or a definition's.
  const echo: Factory<string, string> = (input) =>
    Workflow.create({ execute: async (value) => value, input, name: "echo" });
  engine.task({ name: "save", run: () => 1 });
  expect(() => engine.register("save", echo)).toThrow(
    'register("save"): already registered'
  );
  expect(() => engine.register("taken", echo)).toThrow(
    'register("taken"): already registered'
  );
  await engine.start();
  await expect(engine.launch("missing", {})).rejects.toThrow("missing");
  expect(engine.executions.list()).toEqual([]);
});

it("drains queued runs on a stop, and cancels them on a cancelling stop", async () => {
  const engine = engineWith();
  const order: number[] = [];
  engine.task<number, number>({
    name: "note",
    run: async (n) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      order.push(n);
      return n;
    },
  });
  await engine.start();
  const runs = await Promise.all(
    [1, 2, 3].map((n) => engine.launch<number>("note", n))
  );
  await engine.stop();
  expect(order).toEqual([1, 2, 3]);
  expect(await Promise.all(runs.map((run) => run.result))).toEqual([1, 2, 3]);

  const cancelling = engineWith();
  const gates = new Map<string, () => void>();
  const started: string[] = [];
  blockingTask(cancelling, "work", started, gates);
  await cancelling.start();
  const first = await cancelling.launch("work", { label: "a" });
  const second = await cancelling.launch("work", { label: "b" });
  await cancelling.stop({ cancel: true });
  await expect(first.result).rejects.toThrow();
  await expect(second.result).rejects.toThrow("cancelled before it started");
  expect(started).toEqual(["a"]);
  expect(cancelling.executions.list().map((run) => run.status)).toEqual([
    "cancelled",
    "cancelled",
  ]);
});

it("keeps JsonSessionStore usable through the Agents SessionStore seam", () => {
  const store: SessionStore = new JsonSessionStore(join(root, "sessions"));
  expect(typeof store.appendMessage).toBe("function");
});
