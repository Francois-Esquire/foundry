import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SessionStore } from "@foundry/agents/store";
import { Workflow } from "@foundry/workflows/workflow";
import { expect, it } from "vitest";
import { step } from "~/authoring/builder";
import type { Engine } from "~/lib/engine";
import { type ExecutionRun, Executions } from "~/lib/executions";
import { JsonSessionStore } from "~/lib/sessions/json-store";
import type { StateStore } from "~/lib/state/store";
import { InMemoryStateStore, JsonStateStore } from "~/lib/state/store";
import type { TaskContext } from "~/lib/tasks";
import { dashboardSnapshot } from "~/workspace/snapshot";
import {
  blockingTask,
  executionFixture,
  exitedPid,
  gate,
  orphan,
  until,
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

it("never changes a settled run: late progress, parks, resumes and observations are dropped", async () => {
  const executions = new Executions({
    store: new JsonStateStore(join(fixture.root, "state")),
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
  const state = join(fixture.root, "state");
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

it("prunes only settled runs, records the gap first, and drops a workflow's run file", async () => {
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

it("keeps JsonSessionStore usable through the Agents SessionStore seam", () => {
  const store: SessionStore = new JsonSessionStore(
    join(fixture.root, "sessions")
  );
  expect(typeof store.commit).toBe("function");
});

it("skips observations that are not ones, in a record and in its log, without failing the start", async () => {
  const state = join(fixture.root, "state");
  const store = new JsonStateStore(state);
  orphan(store, {
    id: "rn-bad",
    kind: "task",
    name: "save",
    observations: [
      null,
      { id: "half" },
      {
        id: "good",
        kind: "effect",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "complete",
        type: "write",
      },
    ] as unknown as ExecutionRun["observations"],
    status: "running",
  });
  store.append("observations", "rn-bad", {
    observation: null,
    revision: 9,
    updatedAt: "x",
  });
  store.append("observations", "rn-bad", {
    observation: {
      id: "tool",
      kind: "tool-call",
      startedAt: "s",
      status: "nope",
    },
    revision: 10,
    updatedAt: "x",
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

it("keeps observations durable on a store that has no logs", async () => {
  const backing = new InMemoryStateStore();
  const {
    append: _append,
    log: _log,
    ...rest
  } = Object.fromEntries(
    (
      [
        "append",
        "list",
        "lock",
        "log",
        "read",
        "remove",
        "revision",
        "write",
      ] as const
    ).map((method) => [method, backing[method].bind(backing)])
  ) as Required<StateStore>;
  const store: StateStore = rest;
  const engine = engineWith({ store });
  const { promise: observed, resolve: seen } = Promise.withResolvers<void>();
  const { promise: done, resolve: finish } = Promise.withResolvers<void>();
  engine.task({
    name: "save",
    run: async (_input: unknown, { observe }: TaskContext) => {
      observe({ id: "w", kind: "effect", status: "running", type: "write" });
      seen();
      await done;
    },
  });
  await engine.start();
  const launched = await engine.launch("save", {});
  await observed;

  // On the record itself, before the run settles.
  expect(backing.read("executions", launched.id)).toMatchObject({
    observations: [{ id: "w", status: "running" }],
    status: "running",
  });
  finish();
  await launched.result;
  expect(backing.read("executions", launched.id)).toMatchObject({
    observations: [{ id: "w" }],
    status: "complete",
  });
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
  const subscription = engine.executions.subscribe((run) => {
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
  const store = new InMemoryStateStore();
  const first = engineWith({ store });
  first.task({ name: "save", run: () => undefined });
  await first.start();
  const second = engineWith({ store });
  second.task({ name: "save", run: () => undefined });
  await second.start();

  const elsewhere = await second.launch("save", {});
  await elsewhere.result;
  const fresh = first.executions.subscribe(() => undefined);
  fresh.unsubscribe();
  expect(fresh.snapshot.find((run) => run.id === elsewhere.id)?.status).toBe(
    "complete"
  );

  second.executions.prune([elsewhere.id], () => "host");
  const after = first.executions.subscribe(() => undefined);
  after.unsubscribe();
  expect(after.snapshot.map((run) => run.id)).not.toContain(elsewhere.id);
});

it("returns the run another engine sharing the store started for the same source", async () => {
  const store = new InMemoryStateStore();
  let runs = 0;
  const sharing = [engineWith({ store }), engineWith({ store })];
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

  const original = await first.launch("save", {}, { source: "request-1" });
  const again = await second.launch("save", {}, { source: "request-1" });

  expect(again.id).toBe(original.id);
  await original.result;
  expect(runs).toBe(1);
});

it("keeps a run's record when its cleanup fails, so pruning it again retries", async () => {
  const state = join(fixture.root, "state");
  step("flow").do(() => "ran");
  const engine = engineWith({ state });
  await engine.start();
  const flow = await engine.launch<string>("flow", {});
  await flow.result;
  const file = join(state, "runs", `${flow.id}.json`);
  rmSync(file);
  // A directory where the file was: removing it fails.
  mkdirSync(join(file, "blocked"), { recursive: true });

  expect(engine.executions.prune([flow.id], () => "host")).toEqual([]);
  expect(engine.executions.gaps()).toEqual([]);
  expect(engine.executions.get(flow.id)?.status).toBe("complete");
  expect(existsSync(join(state, "executions", `${flow.id}.json`))).toBe(true);
  expect((await engine.runs()).map((run) => run.id)).toContain(flow.id);

  rmSync(file, { recursive: true });
  expect(engine.executions.prune([flow.id], () => "host")).toHaveLength(1);
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

it("accumulates retention across stale engines without counting the same removal twice", () => {
  const state = join(fixture.root, "shared-prune");
  const store = new JsonStateStore(state);
  const first = new Executions({ store, warn: () => undefined });
  const second = new Executions({
    store: new JsonStateStore(state),
    warn: () => undefined,
  });
  const make = (name: string) =>
    first.enqueue({ kind: "task", name, queue: "default" }).run;
  const older = make("older");
  const newer = make("newer");
  first.settle(older.id, "complete");
  first.settle(newer.id, "complete");
  // Distinct settlements make a backwards through-watermark observable.
  for (const [run, settledAt] of [
    [older, "2026-01-01T00:00:00.000Z"],
    [newer, "2026-01-02T00:00:00.000Z"],
  ] as const) {
    const stored = first.get(run.id);
    if (!stored) {
      throw new Error("settled run missing");
    }
    store.write("executions", run.id, {
      ...stored,
      timestamps: { ...stored.timestamps, settledAt },
    });
  }
  // Both readers predate either prune. The second must merge durable gaps.
  first.load();
  second.load();
  const through = [
    first.get(older.id)?.timestamps.settledAt,
    first.get(newer.id)?.timestamps.settledAt,
  ]
    .sort()
    .at(-1);
  expect(first.prune([newer.id], () => "host")).toHaveLength(1);
  expect(second.prune([newer.id, older.id], () => "host")).toHaveLength(1);
  expect(second.gaps()).toMatchObject([{ removed: 2, scope: "host", through }]);
  first.load();
  expect(first.gaps()).toEqual(second.gaps());
});

it("leaves retention and records unchanged when another process is pruning", () => {
  const store = new InMemoryStateStore();
  const runs = new Executions({ store, warn: () => undefined });
  const { run } = runs.enqueue({
    kind: "task",
    name: "finished",
    queue: "default",
  });
  runs.settle(run.id, "complete");
  const lock = store.lock("retention-gaps");
  expect(lock).toBeDefined();
  try {
    expect(() => runs.prune([run.id], () => "host")).toThrow("retention");
    expect(runs.get(run.id)?.status).toBe("complete");
    expect(runs.gaps()).toEqual([]);
  } finally {
    if (lock && "release" in lock) {
      lock.release();
    }
  }
  expect(runs.prune([run.id], () => "host")).toHaveLength(1);
});
