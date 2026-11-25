import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createQueueClient } from "@foundry/queue/client";
import { QueueStore } from "@foundry/queue/store";
import { makeMemoryQueueStore } from "@foundry/queue/store/memory";
import type { Container } from "@foundry/sandbox/container/containers";
import { Step } from "@foundry/workflows/step";
import { Workflow } from "@foundry/workflows/workflow";
import { Effect, Layer } from "effect";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { step } from "~/authoring/builder";
import { executionOf } from "~/lib/execution-record";
import { MemoryExecutionStore } from "~/lib/execution-store";
import { Executions } from "~/lib/executions";
import type { Factory } from "~/lib/run-queue";
import type { TaskContext } from "~/lib/tasks";
import { dashboardSnapshot } from "~/workspace/snapshot";
import {
  blockingTask,
  executionFixture,
  gate,
  storedExecution,
  until,
} from "../helpers/executions";

const fixture = executionFixture();
const engineWith = fixture.engine;

it("admits a pool in FIFO order, one at a time by default", async () => {
  const engine = engineWith();
  expect(await engine.executions.pools()).toEqual([]);
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
  expect(engine.executions.list().map((run) => run.pool)).toEqual(
    new Array(5).fill("default")
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
    const state = join(fixture.root, "state");
    const engine = engineWith({ state });
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
      expect(records.every((run) => run.pool === "default")).toBe(true);
      for (const record of records) {
        expect(await storedExecution(state, record.id)).toMatchObject({
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
  const engine = engineWith({ pools: { system: { limit: 1 } } });
  const order: number[] = [];
  engine.task<number, number>({
    name: "save",
    pool: "system",
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
    pools: { authoring: { limit: 2 }, workflows: { limit: 1 } },
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
  expect(await engine.executions.pools()).toEqual(
    expect.arrayContaining([
      { active: 2, limit: 2, name: "authoring", state: "active", waiting: 1 },
      { active: 1, limit: 1, name: "workflows", state: "active", waiting: 2 },
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

  await engine.executions.configurePool("module:a:authoring", { limit: 3 });
  await until(() => started.length === 3);
  expect(started).toEqual(["a", "b", "c"]);

  await engine.executions.configurePool("module:a:authoring", { limit: 1 });
  gates.get("a")?.();
  gates.get("b")?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(started).toEqual(["a", "b", "c"]);
  gates.get("c")?.();
  await until(() => started.length === 4);
  gates.get("d")?.();
  await Promise.all(runs.map((run) => run.result));
  await expect(
    engine.executions.configurePool("x", { limit: 0 })
  ).rejects.toMatchObject({ _tag: "InvalidPoolLimitError" });
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
  expect(runIds).toEqual([first.id, second.id]);

  const snapshot = dashboardSnapshot(await engine.runs(), {
    definitions: engine.definitions(),
    monitors: new Map(),
    queued: engine.executions.list(),
    root: fixture.root,
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

it("rejects a wait on a run whose job another queue cancelled and removed", async () => {
  const store = Layer.succeed(QueueStore, Effect.runSync(makeMemoryQueueStore));
  const here = createQueueClient({ store, syncIntervalMs: 10 });
  const elsewhere = createQueueClient({ store });
  const executions = new Executions({
    store: new MemoryExecutionStore(),
    warn: () => undefined,
  });
  executions.attach({ ...here, instanceId: randomUUID() });
  try {
    await elsewhere.register("held", () => ({
      kind: "complete",
      output: null,
    }));
    await elsewhere.configurePool({ limit: 1, name: "held", state: "paused" });
    const job = await elsewhere.submit({
      handler: { name: "held" },
      pool: "held",
      runId: "rn-removed",
    });
    const waiting = executions.settled("rn-removed");
    await elsewhere.cancel(job.id, "gone");
    await elsewhere.removeJob(job.id);
    await expect(waiting).rejects.toThrow();
  } finally {
    executions.detach();
    await here.dispose();
    await elsewhere.dispose();
  }
});

it("keeps a live run learned while load() is snapshotting the store", async () => {
  const store = Layer.succeed(QueueStore, Effect.runSync(makeMemoryQueueStore));
  const queue = createQueueClient({ store });
  const executions = new Executions({
    store: new MemoryExecutionStore(),
    warn: () => undefined,
  });
  const paused = gate();
  const resume = gate();
  let gated = false;
  executions.attach({
    ...queue,
    instanceId: randomUUID(),
    listRuns: async (filter) => {
      const runs = await queue.listRuns(filter);
      if (!gated) {
        gated = true;
        paused.open();
        await resume.opened;
      }
      return runs;
    },
  });
  try {
    await queue.register("held", () => ({ kind: "complete", output: null }));
    await queue.configurePool({ limit: 1, name: "held", state: "paused" });
    const loading = executions.load();
    await paused.opened;
    await queue.submit({
      handler: { name: "held" },
      pool: "held",
      runId: "rn-arrived",
    });
    await until(() => executions.get("rn-arrived") !== undefined);
    const waiting = executions.settled("rn-arrived");
    resume.open();
    await loading;
    expect(executions.get("rn-arrived")?.status).toBe("queued");
    await queue.cancel("rn-arrived", "done");
    expect((await waiting).status).toBe("cancelled");
  } finally {
    executions.detach();
    await queue.dispose();
  }
});

it("uses run.state.queuedAt for queued retries instead of job.createdAt", () => {
  const record = executionOf(
    {
      createdAt: 1000,
      handler: { name: "work" },
      id: "jb-1",
      input: null,
      links: {},
      policy: {},
      pool: "default",
      state: { kind: "pending" },
    },
    {
      attempt: 2,
      id: "rn-2",
      jobId: "jb-1",
      pool: "default",
      revision: 1,
      state: { availableAt: 5000, kind: "queued", queuedAt: 4000 },
    }
  );
  expect(record.timestamps.queuedAt).toBe(new Date(4000).toISOString());
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

it("leaves a settled task as it is when it is cancelled", async () => {
  const engine = engineWith();
  engine.task({ name: "save", run: () => "saved" });
  await engine.start();
  const launched = await engine.launch("save", {});
  await launched.result;
  await expect(engine.cancel(launched.id)).resolves.toBeUndefined();
  expect(engine.executions.get(launched.id)?.status).toBe("complete");
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

it("keeps a long-lived run in an unbounded queue running beside bounded work, until it is cancelled", async () => {
  const state = join(fixture.root, "state");
  const engine = engineWith({
    pools: { programs: { limit: Number.POSITIVE_INFINITY } },
    state,
  });
  let stopped = 0;
  engine.task({
    name: "program",
    pool: "programs",
    run: async (_input, { signal }: TaskContext) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
      stopped += 1;
    },
  });
  engine.task({ name: "save", run: () => "saved" });
  await engine.start();
  const program = await engine.launch(
    "program",
    {},
    { correlation: { kind: "program", moduleId: "notes" } }
  );
  const another = await engine.launch("program", {});
  expect(await engine.run("save", {})).toBe("saved");
  expect(engine.executions.get(program.id)?.status).toBe("running");
  expect(engine.executions.get(another.id)?.status).toBe("running");

  await engine.cancel(program.id);
  expect(stopped).toBe(1);
  await expect(program.result).rejects.toThrow("cancelled");
  expect(engine.executions.get(program.id)).toMatchObject({
    correlation: { kind: "program", moduleId: "notes" },
    status: "cancelled",
  });

  await engine.stop({ cancel: true });
  await expect(another.result).rejects.toThrow();
  expect(stopped).toBe(2);
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

it("admits nothing on a cancelling stop while it waits on a dispatch in flight", async () => {
  const ran: string[] = [];
  class Record extends Step<string, string> {
    readonly definitionKey = "test.record";

    protected execute(input: string): Promise<string> {
      ran.push(input);
      return Promise.resolve(input);
    }
  }
  const factory = new Record().factory();
  const engine = engineWith({
    pools: { slow: { limit: 1 }, work: { limit: 1 } },
  });
  const dispatch = gate();
  const dispatching = gate();
  engine.register<string, string>("slow", async (input, context) => {
    dispatching.open();
    await dispatch.opened;
    return factory(input, context);
  });
  engine.register<string, string>("queued", factory);
  const holding = gate();
  engine.task({
    name: "hold",
    pool: "work",
    run: async (_input, { signal }) => {
      signal.addEventListener("abort", holding.open, { once: true });
      await holding.opened;
    },
  });
  await engine.start();
  const launching = engine.launch<string>("slow", "slow", { pool: "slow" });
  await dispatching.opened;
  await engine.launch("hold", {});
  const queued = await engine.launch<string>("queued", "queued", {
    pool: "work",
  });
  expect(engine.executions.get(queued.id)?.status).toBe("queued");

  const closing = gate();
  const close = vi
    .spyOn(engine.interactions, "close")
    .mockImplementation(() => closing.opened);
  const stopping = engine.stop({ cancel: true });
  await until(() => engine.executions.get(queued.id)?.status === "cancelled");
  await until(() => close.mock.calls.length > 0);
  closing.open();
  close.mockRestore();
  holding.open();
  await new Promise((resolve) => setTimeout(resolve, 20));
  dispatch.open();
  await stopping;

  const slow = await launching;
  await expect(slow.result).rejects.toThrow("cancelled");
  await expect(queued.result).rejects.toThrow("cancelled before it started");
  expect(ran).toEqual([]);
  expect(engine.executions.get(queued.id)?.status).toBe("cancelled");
  expect(engine.executions.get(slow.id)?.status).toBe("cancelled");
});

it("peek reloads progress and observations persisted by another instance", async () => {
  const store = Layer.succeed(QueueStore, Effect.runSync(makeMemoryQueueStore));
  const queue = createQueueClient({ store });
  const annexes = new MemoryExecutionStore();
  const first = new Executions({ store: annexes, warn: () => undefined });
  const second = new Executions({ store: annexes, warn: () => undefined });
  first.attach({ ...queue, instanceId: randomUUID() });
  second.attach({ ...queue, instanceId: randomUUID() });
  try {
    await queue.register("held", () => ({ kind: "complete", output: null }));
    await queue.configurePool({ limit: 1, name: "held", state: "paused" });
    await queue.submit({
      handler: { name: "held" },
      input: null,
      pool: "held",
      runId: "rn-annex",
    });
    await first.peek("rn-annex");
    await second.peek("rn-annex");
    first.progress("rn-annex", { stage: "review" });
    await first.observe("rn-annex", {
      id: "obs",
      kind: "effect",
      startedAt: new Date().toISOString(),
      status: "complete",
      type: "review",
    });
    await first.flush();
    const refreshed = await second.peek("rn-annex");
    expect(refreshed?.progress).toEqual({ stage: "review" });
    expect(refreshed?.observations).toEqual([
      expect.objectContaining({ id: "obs" }),
    ]);
  } finally {
    first.detach();
    second.detach();
    await queue.dispose();
  }
});
