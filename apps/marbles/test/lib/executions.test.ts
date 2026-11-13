import { join } from "node:path";
import type { Container } from "@foundry/sandbox/container/containers";
import type { Factory } from "@foundry/workflows/orchestrator";
import { Step } from "@foundry/workflows/step";
import { Workflow } from "@foundry/workflows/workflow";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { step } from "~/authoring/builder";
import { JsonStateStore } from "~/lib/state/store";
import type { TaskContext } from "~/lib/tasks";
import { dashboardSnapshot } from "~/workspace/snapshot";
import {
  blockingTask,
  executionFixture,
  gate,
  until,
} from "../helpers/executions";

const fixture = executionFixture();
const engineWith = fixture.engine;

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
    const state = join(fixture.root, "state");
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

it("keeps a long-lived run running after it gives up its slot, until it is stopped", async () => {
  const state = join(fixture.root, "state");
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
    queues: { slow: { concurrency: 1 }, work: { concurrency: 1 } },
  });
  const dispatch = gate();
  engine.register<string, string>("slow", async (input, context) => {
    await dispatch.opened;
    return factory(input, context);
  });
  engine.register<string, string>("queued", factory);
  const holding = gate();
  engine.task({
    name: "hold",
    queue: "work",
    run: async (_input, { signal }) => {
      signal.addEventListener("abort", holding.open, { once: true });
      await holding.opened;
    },
  });
  await engine.start();
  const launching = engine.launch<string>("slow", "slow", { queue: "slow" });
  await until(() =>
    engine.executions.list().some((run) => run.name === "slow")
  );
  await engine.launch("hold", {});
  const queued = await engine.launch<string>("queued", "queued", {
    queue: "work",
  });
  expect(engine.executions.get(queued.id)?.status).toBe("queued");

  const closing = gate();
  const close = vi
    .spyOn(engine.interactions, "close")
    .mockImplementation(() => closing.opened);
  const stopping = engine.stop({ cancel: true });
  // Withdraw before waiting on delivery or interaction shutdown.
  expect(engine.executions.get(queued.id)?.status).toBe("cancelled");
  await until(() => close.mock.calls.length > 0);
  closing.open();
  close.mockRestore();
  // The task frees its slot while the stop still waits on the factory.
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
