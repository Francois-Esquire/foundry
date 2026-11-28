import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { thisProcess } from "@foundry/lib/node/process-identity";
import { expect, it, vi } from "vitest";
import { step } from "~/authoring/builder";
import { DatabaseExecutionStore } from "~/database/executions";
import { readDatabase } from "~/database/open";
import { marblesExecutions } from "~/database/tables";
import { stateDatabase } from "~/layout";
import type { Context } from "~/lib/definitions/types";
import type { Engine } from "~/lib/engine";
import type { ExecutionRun } from "~/lib/executions";
import type { ExecutionStore } from "~/lib/executions/store";
import { MemoryExecutionStore } from "~/lib/executions/store";
import type { TaskContext } from "~/lib/runs/tasks";
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
import { readStoredRuns } from "../helpers/stored-runs";

const fixture = executionFixture();
const engineWith = fixture.engine;

const UNREADABLE_OBSERVATION = /unreadable observation/;
const FUNCTION_INPUT = /input of run rn-[\w-]+\.call holds a function/;
const BIGINT_INPUT = /input of run rn-[\w-]+\.big holds a bigint/;
const DATE_INPUT =
  /input of run rn-[\w-]+\.at holds an object that is not plain/;

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
    pool: "default",
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

it("never changes a settled run: late progress and observations are dropped", async () => {
  const engine = engineWith();
  let late: TaskContext | undefined;
  engine.task({
    name: "save",
    pool: "system",
    run: (_input, context: TaskContext) => {
      late = context;
    },
  });
  await engine.start();
  const launched = await engine.launch("save", {});
  await launched.result;
  const settled = engine.executions.get(launched.id);

  late?.progress({ late: true });
  const observed = await late?.observe({
    id: "late",
    kind: "effect",
    type: "gateway",
  });

  expect(observed).toBe(false);
  expect(engine.executions.get(launched.id)).toEqual(settled);
  expect(await engine.executions.pools()).toEqual([]);
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

  const record = await storedExecution(state, launched.id);
  if (!record) {
    throw new Error(`${launched.id} is not stored`);
  }
  await withExecutions(state, async (seeds) => {
    await seedExecution(seeds, {
      ...record,
      owner: { pid: exitedPid(), started: null },
      revision: 2,
      status: "running",
    });
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
  const written: unknown[] = [];
  const observed: ExecutionStore["observe"] = store.observe.bind(store);
  store.observe = (id, observation, at) => {
    written.push(observation);
    return observed(id, observation, at);
  };
  const engine = engineWith({ executionStore: store });
  engine.task({
    name: "long",
    run: async (_input, { observe }: TaskContext) => {
      for (let index = 0; index < 50; index += 1) {
        await observe({
          id: `o-${String(index)}`,
          kind: "effect",
          type: "write",
        });
      }
    },
  });
  await engine.start();
  const launched = await engine.launch("long", {});
  await launched.result;
  expect(written).toHaveLength(50);
  expect(written.every((item) => !Array.isArray(item))).toBe(true);
  expect((await store.get(launched.id))?.observations).toHaveLength(50);
});

it("prunes only settled runs, records the gap first, and drops a workflow's Run and output", async () => {
  const state = join(fixture.root, "state");
  const flowDef = step("flow").do(() => "ran");
  const engine = engineWith({ state });
  engine.define(flowDef);
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
  expect(updates.slice(0, 2).map((run) => run.status)).toEqual([
    "queued",
    "running",
  ]);
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
  await withExecutions(state, async (seeds) => {
    await orphan(seeds, {
      id: "rn-bad",
      kind: "task",
      name: "save",
      status: "running",
    });
    const store = new DatabaseExecutionStore(seeds);
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
  await Promise.allSettled([original.result, again.result]);
  await until(() => runs === 1);
  expect(runs).toBe(1);
});

it("keeps a run's record when its cleanup fails, so pruning it again retries", async () => {
  const state = join(fixture.root, "state");
  const flowDef = step("flow").do(() => "ran");
  const engine = engineWith({ state });
  engine.define(flowDef);
  await engine.start();
  const flow = await engine.launch<string>("flow", {});
  await flow.result;
  const file = join(state, "output", `${flow.id}.jsonl`);
  rmSync(file);
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
  expect((await engine.runs()).map((run) => run.id)).not.toContain(flow.id);
});

it("accumulates retention across engines without counting the same removal twice", async () => {
  const state = join(fixture.root, "shared-prune");
  const writer = engineWith({ state });
  writer.task({ name: "save", run: () => undefined });
  await writer.start();
  const older = await writer.launch("save", {});
  await older.result;
  const newer = await writer.launch("save", {});
  await newer.result;
  const one = engineWith({ state });
  const two = engineWith({ state });
  await one.start();
  await two.start();
  expect(await one.executions.prune([newer.id], () => "host")).toHaveLength(1);
  expect(
    await two.executions.prune([newer.id, older.id], () => "host")
  ).toHaveLength(1);
  expect(two.executions.gaps()).toMatchObject([{ removed: 2, scope: "host" }]);
  const later = engineWith({ state });
  await later.start();
  expect(later.executions.gaps()).toEqual(two.executions.gaps());
});

it("counts each removal once when two engines prune the same runs at once", async () => {
  const state = join(fixture.root, "racing-prune");
  const writer = engineWith({ state });
  writer.task({ name: "save", run: () => undefined });
  await writer.start();
  const ids: string[] = [];
  for (const _ of [1, 2, 3]) {
    const launched = await writer.launch("save", {});
    await launched.result;
    ids.push(launched.id);
  }
  const pruners = [engineWith({ state }), engineWith({ state })];
  for (const pruner of pruners) {
    await pruner.start();
  }
  const removed = await Promise.all(
    pruners.map((pruner) => pruner.executions.prune(ids, () => "host"))
  );
  expect(
    removed
      .flat()
      .map((run) => run.id)
      .sort()
  ).toEqual([...ids].sort());
  const reader = engineWith({ state });
  await reader.start();
  expect(reader.executions.gaps()).toMatchObject([
    { removed: 3, scope: "host" },
  ]);
  expect(reader.executions.list()).toEqual([]);
});

it("keeps a suspended run's progress in the store the engine was handed, and none in a database it keeps none in", async () => {
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
  await vi.waitFor(async () => {
    expect(engine.executions.get(id)?.status).toBe("suspended");
    expect((await store.get(id))?.progress).toBeDefined();
  });
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
