import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { thisProcess } from "@foundry/lib/process-identity";
import { Workflow } from "@foundry/workflows/workflow";
import { expect, it, vi } from "vitest";
import { step } from "~/authoring/builder";
import { DatabaseExecutionStore } from "~/database/executions";
import { initializeDatabase, readDatabase } from "~/database/open";
import { readStoredRuns } from "~/database/runs";
import { marblesExecutions } from "~/database/tables";
import { stateDatabase } from "~/layout";
import type { Engine } from "~/lib/engine";
import { parseStored } from "~/lib/execution-record";
import type { ExecutionStore } from "~/lib/execution-store";
import { MemoryExecutionStore } from "~/lib/execution-store";
import { type ExecutionRun, Executions } from "~/lib/executions";
import type { TaskContext } from "~/lib/tasks";
import type { Context } from "~/lib/types";
import { dashboardSnapshot } from "~/workspace/snapshot";
import {
  blockingTask,
  executionFixture,
  exitedPid,
  gate,
  orphan,
  seedExecution,
  storedExecution,
  until,
  withExecutions,
} from "../helpers/executions";

const fixture = executionFixture();
const engineWith = fixture.engine;

const UNREADABLE_OBSERVATION = /unreadable observation/;
const FUNCTION_INPUT = /input\.call is not JSON: it is a function/;
const BIGINT_INPUT = /input\.big is not JSON/;
const DATE_INPUT = /input\.at is not JSON: it is a Date/;

it("writes a run when it is queued, before it starts, and when it settles", async () => {
  const state = join(fixture.root, "state");
  const engine = engineWith({ state });
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

  // Each of these is on disk before the launch, start or result it precedes.
  const stored = async (id: string) => {
    const run = await storedExecution(state, id);
    if (!run) {
      throw new Error(`${id} is not stored`);
    }
    return run;
  };
  expect(await stored(first.id)).toMatchObject({
    correlation: { moduleId: "notes" },
    kind: "task",
    name: "build",
    owner: thisProcess(),
    queue: "marbles",
    status: "running",
  });
  expect((await stored(first.id)).input).toBeUndefined();
  expect((await stored(first.id)).timestamps.startedAt).toBeDefined();
  expect(await stored(second.id)).toMatchObject({
    input: { label: "two" },
    status: "queued",
  });

  gates.get("one")?.();
  await first.result;
  expect(await stored(first.id)).toMatchObject({ status: "complete" });
  expect((await stored(first.id)).timestamps.settledAt).toBeDefined();
  await until(() => started.length === 2);
  gates.get("two")?.();
  await second.result;
  expect((await stored(second.id)).status).toBe("complete");
});

it("never changes a settled run: late progress, parks, resumes and observations are dropped", async () => {
  const executions = new Executions({
    store: new MemoryExecutionStore(),
    warn: () => undefined,
  });
  const { run } = await executions.enqueue({
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
  await executions.settle(run.id, "complete");
  const settled = executions.get(run.id);

  executions.progress(run.id, { late: true });
  executions.suspend(run.id);
  executions.resume(run.id);
  const observed = await executions.observe(run.id, {
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

it("records a running run's observations one at a time, beside its record, and keeps them across a crash", async () => {
  const state = join(fixture.root, "state");
  const engine = engineWith({ state });
  const hold = gate();
  engine.task({
    name: "program",
    run: async (_input, { observe }: TaskContext) => {
      for (const id of ["call-0", "call-1", "call-2"]) {
        await observe({
          id,
          kind: "effect",
          status: "running",
          type: "gateway",
        });
      }
      await observe({ id: "call-1", kind: "effect", type: "gateway" });
      await hold.opened;
    },
  });
  await engine.start();
  const launched = await engine.launch("program", {});
  const live = await vi.waitFor(() => {
    const run = engine.executions.get(launched.id);
    expect(run?.observations.at(-1)).toMatchObject({
      id: "call-1",
      status: "complete",
    });
    return run;
  });
  expect(live?.observations.map(({ id, status }) => `${id}:${status}`)).toEqual(
    ["call-0:running", "call-2:running", "call-1:complete"]
  );
  // Each observation raised the stored revision without rewriting the record.
  const running = await vi.waitFor(async () => {
    const run = await storedExecution(state, launched.id);
    expect(run?.revision).toBe(live?.revision);
    return run;
  });
  expect(running).toMatchObject({
    revision: live?.revision,
    status: "running",
  });
  expect(running?.observations).toEqual(live?.observations);

  hold.open();
  await launched.result;
  const settled = await storedExecution(state, launched.id);
  expect(settled?.status).toBe("complete");
  expect(settled?.observations).toEqual(
    engine.executions.get(launched.id)?.observations
  );
  await engine.dispose();

  // As a crash while it ran leaves it: running, its owner gone.
  const dead = exitedPid();
  await withExecutions(state, async (store) => {
    const stored = await store.get(launched.id);
    const record = stored?.value as ExecutionRun;
    await seedExecution(store, {
      ...record,
      observations: [],
      owner: { pid: dead, started: null },
      status: "running",
    });
    for (const observation of live?.observations ?? []) {
      await store.observe(
        launched.id,
        observation,
        record.timestamps.updatedAt
      );
    }
  });
  const next = engineWith({ state });
  await next.start();
  const recovered = next.executions.get(launched.id);
  expect(recovered).toMatchObject({ status: "interrupted" });
  expect(recovered?.observations).toEqual(live?.observations);
  expect(recovered?.revision).toBeGreaterThan(live?.revision ?? 0);
});

it("records an observation at the same cost however many its run has", async () => {
  const store = new MemoryExecutionStore();
  const executions = new Executions({ store, warn: () => undefined });
  const { run } = await executions.enqueue({
    kind: "task",
    name: "long",
    queue: "q",
  });
  const observed: ExecutionStore["observe"] = store.observe.bind(store);
  const written: unknown[] = [];
  store.observe = (id, observation, at) => {
    written.push(observation);
    return observed(id, observation, at);
  };
  // Nothing but the observation is written: no lifecycle change, no progress.
  const transition = store.transition.bind(store);
  let puts = 0;
  store.transition = (id, change) => {
    puts += 1;
    return transition(id, change);
  };
  for (let index = 0; index < 50; index += 1) {
    await executions.observe(run.id, {
      id: `o-${String(index)}`,
      kind: "effect",
      startedAt: new Date().toISOString(),
      status: "complete",
      type: "write",
    });
  }
  // One observation handed to the store each time, never the record.
  expect(written).toHaveLength(50);
  expect(written.every((item) => !Array.isArray(item))).toBe(true);
  expect(puts).toBe(0);
  expect((await store.get(run.id))?.observations).toHaveLength(50);
});

it("prunes only settled runs, records the gap first, and drops a workflow's Run and output", async () => {
  const state = join(fixture.root, "state");
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
  const storedIds = async () =>
    (await readStoredRuns(state, "test")).map((run) => run.id);
  expect(await storedIds()).toContain(flow.id);
  expect(existsSync(join(state, "output", `${flow.id}.jsonl`))).toBe(true);

  const removed = await engine.executions.prune(
    [flow.id, held.id, "rn-unknown"],
    (run) => run.correlation.moduleId ?? "host"
  );
  // The running one is untouched; only the settled workflow went.
  expect(removed.map((run) => run.id)).toEqual([flow.id]);
  expect(engine.executions.get(flow.id)).toBeUndefined();
  expect(engine.executions.get(held.id)?.status).toBe("running");
  expect(await storedExecution(state, flow.id)).toBeUndefined();
  expect(await storedIds()).not.toContain(flow.id);
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
  const { snapshot, unsubscribe } = await engine.executions.subscribe((run) => {
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

it("skips observations that are not ones, without failing the start", async () => {
  const state = join(fixture.root, "state");
  await withExecutions(state, async (store) => {
    await orphan(store, {
      id: "rn-bad",
      kind: "task",
      name: "save",
      status: "running",
    });
    const at = "x";
    for (const observation of [
      { id: "half" },
      {
        id: "good",
        kind: "effect",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "complete",
        type: "write",
      },
      { id: "tool", kind: "tool-call", startedAt: "s", status: "nope" },
    ]) {
      await store.observe(
        "rn-bad",
        observation as unknown as ExecutionRun["observations"][number],
        at
      );
    }
  });
  const lines: string[] = [];
  const engine = engineWith({ print: (line) => lines.push(line), state });

  await engine.start();

  expect(engine.executions.get("rn-bad")).toMatchObject({
    observations: [{ id: "good" }],
    status: "interrupted",
  });
  expect(lines.join("\n")).toMatch(UNREADABLE_OBSERVATION);
});

it("keeps an observation's start when a task completes it without one", async () => {
  const engine = engineWith();
  engine.task({
    name: "save",
    run: async (_input: unknown, { observe }: TaskContext) => {
      observe({ id: "w", kind: "effect", status: "running", type: "write" });
      await new Promise((resolve) => setTimeout(resolve, 15));
      observe({ id: "w", kind: "effect", status: "complete", type: "write" });
      observe({
        id: "x",
        kind: "effect",
        startedAt: "2026-01-01T00:00:00.000Z",
        type: "read",
      });
      observe({
        id: "x",
        kind: "effect",
        startedAt: "2026-02-01T00:00:00.000Z",
        type: "read",
      });
    },
  });
  await engine.start();
  let first: string | undefined;
  const subscription = await engine.executions.subscribe((run) => {
    first ??= run.observations.find((item) => item.id === "w")?.startedAt;
  });
  const launched = await engine.launch("save", {});
  await launched.result;
  subscription.unsubscribe();

  const [w, x] = engine.executions.get(launched.id)?.observations ?? [];
  expect(w).toMatchObject({ id: "w", startedAt: first, status: "complete" });
  // One given explicitly replaces it.
  expect(x).toMatchObject({ id: "x", startedAt: "2026-02-01T00:00:00.000Z" });
});

it("records an input as JSON once: a later change to it changes nothing, and what JSON would lose is refused", async () => {
  const engine = engineWith();
  const seen: unknown[] = [];
  const { promise: free, resolve: release } = Promise.withResolvers<void>();
  engine.task({
    name: "first",
    run: () => free,
  });
  engine.task({
    name: "echo",
    run: (given: unknown) => {
      seen.push(given);
    },
  });
  await engine.start();
  const blocking = await engine.launch("first", {});
  const input = { list: [1], nested: { n: 1 } };
  const waiting = await engine.launch("echo", input);
  input.nested.n = 2;
  input.list.push(2);
  release();
  await blocking.result;
  await waiting.result;
  expect(seen).toEqual([{ list: [1], nested: { n: 1 } }]);

  const before = engine.executions.list().length;
  await expect(engine.launch("echo", { call: () => 1 })).rejects.toThrow(
    FUNCTION_INPUT
  );
  await expect(engine.launch("echo", { big: 1n })).rejects.toThrow(
    BIGINT_INPUT
  );
  await expect(engine.launch("echo", { at: new Date() })).rejects.toThrow(
    DATE_INPUT
  );
  expect(engine.executions.list()).toHaveLength(before);
});

it("takes in another engine's runs and prunes when a host subscribes again", async () => {
  const state = join(fixture.root, "state");
  const first = engineWith({ state });
  first.task({ name: "save", run: () => undefined });
  await first.start();
  const second = engineWith({ state });
  second.task({ name: "save", run: () => undefined });
  await second.start();

  const elsewhere = await second.launch("save", {});
  await elsewhere.result;
  const fresh = await first.executions.subscribe(() => undefined);
  fresh.unsubscribe();
  expect(fresh.snapshot.find((run) => run.id === elsewhere.id)?.status).toBe(
    "complete"
  );

  await second.executions.prune([elsewhere.id], () => "host");
  const after = await first.executions.subscribe(() => undefined);
  after.unsubscribe();
  expect(after.snapshot.map((run) => run.id)).not.toContain(elsewhere.id);
  expect(first.executions.gaps()).toMatchObject([
    { removed: 1, scope: "host" },
  ]);
});

it("returns the run another engine sharing the store started for the same source", async () => {
  const state = join(fixture.root, "state");
  let runs = 0;
  const sharing = [engineWith({ state }), engineWith({ state })];
  for (const engine of sharing) {
    engine.task({
      name: "save",
      run: () => {
        runs += 1;
      },
    });
    await engine.start();
  }
  const [first, second] = sharing as [Engine, Engine];

  const [original, again] = await Promise.all([
    first.launch("save", {}, { source: "request-1" }),
    second.launch("save", {}, { source: "request-1" }),
  ]);

  expect(again.id).toBe(original.id);
  // Only the engine that launched it holds its value.
  await Promise.allSettled([original.result, again.result]);
  await until(() => runs === 1);
  expect(runs).toBe(1);
});

it("keeps a run's record when its cleanup fails, so pruning it again retries", async () => {
  const state = join(fixture.root, "state");
  step("flow").do(() => "ran");
  const engine = engineWith({ state });
  await engine.start();
  const flow = await engine.launch<string>("flow", {});
  await flow.result;
  const file = join(state, "output", `${flow.id}.jsonl`);
  rmSync(file);
  // A directory where its output file was: removing it fails.
  mkdirSync(join(file, "blocked"), { recursive: true });

  expect(await engine.executions.prune([flow.id], () => "host")).toEqual([]);
  expect(engine.executions.gaps()).toEqual([]);
  expect(engine.executions.get(flow.id)?.status).toBe("complete");
  expect(await storedExecution(state, flow.id)).toMatchObject({
    status: "complete",
  });
  expect((await engine.runs()).map((run) => run.id)).toContain(flow.id);

  rmSync(file, { recursive: true });
  expect(await engine.executions.prune([flow.id], () => "host")).toHaveLength(
    1
  );
  expect(engine.executions.gaps()).toMatchObject([
    { removed: 1, scope: "host" },
  ]);
  expect(engine.executions.get(flow.id)).toBeUndefined();
  // Gone from what the dashboard and usage read too.
  expect((await engine.runs()).map((run) => run.id)).not.toContain(flow.id);
});

it("shows a workflow run still being set up on the dashboard, once", async () => {
  const engine = engineWith();
  const { promise: setUp, resolve: finishSetup } =
    Promise.withResolvers<void>();
  const { promise: hold, resolve: release } = Promise.withResolvers<void>();
  engine.register<unknown, string>("slow", async (input) => {
    await setUp;
    return Workflow.create({
      execute: async () => {
        await hold;
        return "done";
      },
      input,
      name: "slow",
    });
  });
  await engine.start();
  const rows = async () =>
    dashboardSnapshot(await engine.runs(), {
      definitions: [],
      lastFinish: new Map(),
      monitors: new Map(),
      queued: engine.executions.list(),
      root: fixture.root,
      schedules: [],
      startedAt: Date.now(),
      status: "running",
    }).runs.map((row) => [row.id, row.status]);
  const launching = engine.launch<string>("slow", {});
  await until(() =>
    engine.executions.list().some((item) => item.status === "running")
  );
  const [run] = engine.executions.list();

  expect(await rows()).toEqual([[run?.id, "running"]]);
  finishSetup();
  const launched = await launching;
  // The Orchestrator's record takes over the row: still one.
  expect((await rows()).map(([id]) => id)).toEqual([run?.id]);
  release();
  await launched.result;
});

it("accumulates retention across stale engines without counting the same removal twice", async () => {
  const state = join(fixture.root, "shared-prune");
  await withExecutions(state, async (store) => {
    const first = new Executions({ store, warn: () => undefined });
    const make = async (name: string) =>
      (await first.enqueue({ kind: "task", name, queue: "default" })).run;
    const older = await make("older");
    const newer = await make("newer");
    // Distinct settlements make a backwards through-watermark observable.
    for (const [run, settledAt] of [
      [older, "2026-01-01T00:00:00.000Z"],
      [newer, "2026-01-02T00:00:00.000Z"],
    ] as const) {
      await first.settle(run.id, "complete");
      const settled = first.get(run.id);
      if (!settled) {
        throw new Error("settled run missing");
      }
      await seedExecution(store, {
        ...settled,
        revision: settled.revision + 1,
        timestamps: { ...settled.timestamps, settledAt },
      });
    }
    // Both readers predate either prune. The second must merge durable gaps.
    const reader = () => new Executions({ store, warn: () => undefined });
    const one = reader();
    const two = reader();
    await one.load();
    await two.load();
    expect(await one.prune([newer.id], () => "host")).toHaveLength(1);
    expect(await two.prune([newer.id, older.id], () => "host")).toHaveLength(1);
    expect(two.gaps()).toMatchObject([
      { removed: 2, scope: "host", through: "2026-01-02T00:00:00.000Z" },
    ]);
    const later = reader();
    await later.load();
    expect(later.gaps()).toEqual(two.gaps());
  });
});

it("counts each removal once when two engines prune the same runs at once", async () => {
  const state = join(fixture.root, "racing-prune");
  await withExecutions(state, async (store) => {
    const writer = new Executions({ store, warn: () => undefined });
    const ids: string[] = [];
    for (const name of ["a", "b", "c"]) {
      const { run } = await writer.enqueue({ kind: "task", name, queue: "q" });
      await writer.settle(run.id, "complete");
      ids.push(run.id);
    }
    const pruners = [0, 1].map(
      () => new Executions({ store, warn: () => undefined })
    );
    for (const pruner of pruners) {
      await pruner.load();
    }
    const removed = await Promise.all(
      pruners.map((pruner) => pruner.prune(ids, () => "host"))
    );
    expect(
      removed
        .flat()
        .map((run) => run.id)
        .sort()
    ).toEqual([...ids].sort());
    expect(await store.gaps()).toMatchObject([{ removed: 3, scope: "host" }]);
    expect(await store.list()).toEqual([]);
  });
});

it("parks a workflow's Execution Run with its Run, in one write, and warns of nothing", async () => {
  const state = join(fixture.root, "state");
  const lines: string[] = [];
  const opened = await initializeDatabase(stateDatabase(state));
  const store = new DatabaseExecutionStore({
    database: opened.database,
    scope: "test",
  });
  // Each park the engine makes itself, and whether it was made.
  const parks: boolean[] = [];
  const transition = store.transition.bind(store);
  store.transition = async (runId, change) => {
    const written = await transition(runId, change);
    if (change.status === "suspended") {
      parks.push(written.applied);
    }
    return written;
  };
  const engine = engineWith({
    askable: true,
    executionStore: store,
    print: (line) => lines.push(line),
    state,
  });
  engine.define({
    fn: ({ ask }: Context) => ask.question({ title: "continue?" }),
    kind: "step",
    name: "probe",
  });
  await engine.start();
  const { id } = await engine.launch("probe", {});
  await vi.waitFor(() =>
    expect(engine.executions.get(id)?.status).toBe("suspended")
  );
  const parked = engine.executions.get(id);
  await vi.waitFor(async () =>
    expect(await storedExecution(state, id)).toMatchObject({
      revision: parked?.revision,
      status: "suspended",
    })
  );
  // The Run's commit made it: the engine's own park found it made.
  expect(parks).toEqual([false]);
  expect(lines.filter((line) => line.startsWith("[state]"))).toEqual([]);
  await engine.dispose();
  opened.close();
});

async function storedOf(
  store: ExecutionStore,
  id: string
): Promise<ExecutionRun | undefined> {
  const stored = await store.get(id);
  return stored && parseStored(stored);
}

it("parks into the store the engine was handed, and writes no Execution Run to a database it keeps none in", async () => {
  const state = join(fixture.root, "state");
  const store = new MemoryExecutionStore();
  const engine = engineWith({ askable: true, executionStore: store, state });
  engine.define({
    fn: ({ ask }: Context) => ask.question({ title: "continue?" }),
    kind: "step",
    name: "probe",
  });
  await engine.start();
  const { id } = await engine.launch("probe", {});
  await vi.waitFor(async () =>
    expect(await storedOf(store, id)).toMatchObject({ status: "suspended" })
  );
  const rows = await readDatabase(stateDatabase(state), (database) =>
    database.select().from(marblesExecutions)
  );
  expect(rows).toEqual([]);
});

it("has every change on disk once it is disposed, those it never waited for included", async () => {
  const state = join(fixture.root, "state");
  const engine = engineWith({ state });
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  blockingTask(engine, "build", started, gates);
  await engine.start();
  const running = await engine.launch("build", { label: "one" });
  running.result.catch(() => undefined);
  const queued = await engine.launch("build", { label: "two" });
  queued.result.catch(() => undefined);
  await until(() => started.length === 1);
  // Withdrawn and recorded cancelled here at once; written in its turn.
  const cancelling = engine.cancel(queued.id);
  await engine.dispose();
  await cancelling;
  expect(await storedExecution(state, queued.id)).toMatchObject({
    status: "cancelled",
  });
  expect(await storedExecution(state, running.id)).toMatchObject({
    status: "cancelled",
  });
});
