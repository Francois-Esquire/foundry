import { thisProcess } from "@foundry/lib/process-identity";
import { Tasks } from "@foundry/tasks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { step } from "~/authoring/builder";
import { catalog } from "~/authoring/catalog";
import { setHost } from "~/authoring/runtime";
import type { Engine } from "~/lib/engine";
import { TASKS } from "~/lib/events/source";
import { testEngine } from "../helpers/engine";

/**
 * An engine that has begun to retire starts no run that comes from
 * outside its own active runs, and runs whole what they start themselves:
 * a child, a child of a child, a child queued behind a busy queue.
 */

const engines: Engine[] = [];

afterEach(async () => {
  catalog.reset();
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
});

function engineHere(): Engine {
  const engine = testEngine({ print: () => undefined });
  engines.push(engine);
  return engine;
}

const RETIRING = /^EngineRetiringError/;

const successor = () => ({ pid: thisProcess().pid + 1, started: null });

/** What `promise` settles to, a rejection as its name and message. */
function outcome(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => value,
    (error: Error) => `${error.name}: ${error.message}`
  );
}

describe("an engine that has begun to retire", () => {
  it("closes admission before it waits for an observer to finish", async () => {
    const engine = engineHere();
    const entered = Promise.withResolvers<void>();
    const observing = Promise.withResolvers<void>();
    const finishing = Promise.withResolvers<void>();
    const started: string[] = [];
    engine.observe(TASKS, async () => {
      entered.resolve();
      await observing.promise;
    });
    engine.task({
      name: "active",
      run: async () => {
        started.push("active");
        await finishing.promise;
      },
    });
    engine.task({
      name: "queued",
      run: () => {
        started.push("queued");
      },
    });
    await engine.start();
    await new Tasks({ store: engine.taskStore }).create({ title: "held" });
    await entered.promise;
    const active = await engine.launch("active", {});
    const queued = await engine.launch("queued", {});
    queued.result.catch(() => undefined);
    const retiring = engine.retire(successor());
    // The slot frees while the observer still holds the retirement.
    finishing.resolve();
    await active.result;
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual(["active"]);
    observing.resolve();
    await retiring;
    expect(started).toEqual(["active"]);
  });

  it("refuses to resume a paused run once retirement began, before that run is let go", async () => {
    const engine = engineHere();
    const entered = Promise.withResolvers<void>();
    const observing = Promise.withResolvers<void>();
    const resumed: string[] = [];
    engine.observe(TASKS, async () => {
      entered.resolve();
      await observing.promise;
    });
    engine.define({
      fn: async ({ signal }: { readonly signal: AbortSignal }) => {
        resumed.push("entered");
        await new Promise((resolve) =>
          signal.addEventListener("abort", resolve)
        );
      },
      kind: "step",
      name: "paused",
    });
    await engine.start();
    const run = await engine.launch("paused", {});
    run.result.catch(() => undefined);
    await vi.waitFor(() => expect(resumed).toEqual(["entered"]));
    expect(engine.pause(run.id, "paused", "hold")).toBe(true);
    await vi.waitFor(() =>
      expect(engine.executions.get(run.id)?.status).toBe("suspended")
    );
    await new Tasks({ store: engine.taskStore }).create({ title: "held" });
    await entered.promise;
    // Retirement waits on the observer: the paused run is not let go yet.
    const retiring = engine.retire(successor());
    await expect(engine.resume(run.id, "paused")).rejects.toMatchObject({
      name: "QuestionMovingError",
    });
    expect(resumed).toEqual(["entered"]);
    observing.resolve();
    await retiring;
  });

  it("hands its queued runs over without waiting for an observer, and ends once its runs have, the observer still running", async () => {
    const engine = engineHere();
    const entered = Promise.withResolvers<void>();
    const observing = Promise.withResolvers<void>();
    const finishing = Promise.withResolvers<void>();
    engine.observe(TASKS, async () => {
      entered.resolve();
      await observing.promise;
    });
    engine.task({
      name: "active",
      run: async () => {
        await finishing.promise;
      },
    });
    engine.task({ name: "queued", run: () => undefined });
    await engine.start();
    await new Tasks({ store: engine.taskStore }).create({ title: "held" });
    await entered.promise;
    const active = await engine.launch("active", {});
    const queued = await engine.launch("queued", {});
    queued.result.catch(() => undefined);
    const next = successor();
    // The observer still runs: the hand-over does not wait for it.
    const retired = await engine.retire(next);
    expect(engine.executions.get(queued.id)?.owner).toMatchObject({
      pid: next.pid,
    });
    finishing.resolve();
    await active.result;
    // The observer has not returned: it holds nothing here.
    await retired.ended;
    observing.resolve();
  });

  it("runs a child a task active here launches after retirement began", async () => {
    const engine = engineHere();
    const gate = Promise.withResolvers<void>();
    engine.task({ name: "child", queue: "child", run: () => 42 });
    engine.task({
      name: "parent",
      run: async () => {
        await gate.promise;
        return await (await engine.launch<number>("child", {})).result;
      },
    });
    await engine.start();
    const parent = await engine.launch("parent", {});
    const { ended } = await engine.retire(successor());
    gate.resolve();
    expect(await outcome(parent.result)).toBe(42);
    await ended;
  });

  it("runs a child of a child, and a child of a workflow step, there too", async () => {
    const engine = engineHere();
    const gate = Promise.withResolvers<void>();
    engine.task({ name: "grandchild", queue: "g", run: () => 7 });
    engine.task({
      name: "child",
      queue: "c",
      run: async () =>
        2 * (await (await engine.launch<number>("grandchild", {})).result),
    });
    engine.define({
      fn: async () => {
        await gate.promise;
        return (await (await engine.launch<number>("child", {})).result) + 1;
      },
      kind: "step",
      name: "parent",
    });
    await engine.start();
    const parent = await engine.launch("parent", {});
    const { ended } = await engine.retire(successor());
    gate.resolve();
    expect(await outcome(parent.result)).toBe(15);
    await ended;
  });

  it("runs a child queued behind a busy queue here, not on the next engine", async () => {
    const engine = engineHere();
    const parentGate = Promise.withResolvers<void>();
    const busyGate = Promise.withResolvers<void>();
    const ran: string[] = [];
    engine.task({
      name: "busy",
      queue: "shared",
      run: async () => {
        ran.push("busy");
        await busyGate.promise;
      },
    });
    engine.task({
      name: "child",
      queue: "shared",
      run: () => {
        ran.push("child");
        return 42;
      },
    });
    engine.task({
      name: "parent",
      run: async () => {
        await parentGate.promise;
        return await (await engine.launch<number>("child", {})).result;
      },
    });
    await engine.start();
    const busy = await engine.launch("busy", {});
    const parent = await engine.launch("parent", {});
    const { ended } = await engine.retire(successor());
    parentGate.resolve();
    // The child waits behind busy, which holds the queue's one slot.
    await new Promise((resolve) => setImmediate(resolve));
    expect(ran).toEqual(["busy"]);
    busyGate.resolve();
    await busy.result;
    expect(await outcome(parent.result)).toBe(42);
    expect(ran).toEqual(["busy", "child"]);
    await ended;
  });

  it("hands over a child queued behind a busy queue whose parent parked before retirement began", async () => {
    const engine = engineHere();
    const busyGate = Promise.withResolvers<void>();
    const childLaunched = Promise.withResolvers<string>();
    const ran: string[] = [];
    engine.task({
      name: "busy",
      queue: "shared",
      run: async () => {
        ran.push("busy");
        await busyGate.promise;
      },
    });
    engine.task({
      name: "child",
      queue: "shared",
      run: () => {
        ran.push("child");
      },
    });
    engine.define({
      fn: async ({ signal }: { readonly signal: AbortSignal }) => {
        const child = await engine.launch("child", {});
        child.result.catch(() => undefined);
        childLaunched.resolve(child.id);
        await new Promise((resolve) =>
          signal.addEventListener("abort", resolve)
        );
      },
      kind: "step",
      name: "parent",
    });
    await engine.start();
    const busy = await engine.launch("busy", {});
    const parent = await engine.launch("parent", {});
    parent.result.catch(() => undefined);
    const childId = await childLaunched.promise;
    // The parent parks waiting, its child queued behind busy.
    expect(engine.pause(parent.id, "parent", "hold")).toBe(true);
    await vi.waitFor(() =>
      expect(engine.executions.get(parent.id)?.status).toBe("suspended")
    );
    const next = successor();
    await engine.retire(next);
    busyGate.resolve();
    await busy.result;
    // Its parent is moving: the child goes with the queue, not run here.
    expect(ran).toEqual(["busy"]);
    expect(engine.executions.get(childId)?.owner).toMatchObject({
      pid: next.pid,
    });
  });

  it("runs a child a cancelled task launches before its body returns", async () => {
    const engine = engineHere();
    const launched = Promise.withResolvers<unknown>();
    engine.task({ name: "child", queue: "child", run: () => 42 });
    engine.task({
      name: "parent",
      run: async (_input, context) => {
        await new Promise((resolve) =>
          context.signal.addEventListener("abort", resolve)
        );
        launched.resolve(
          await outcome(
            engine.launch<number>("child", {}).then((child) => child.result)
          )
        );
      },
    });
    await engine.start();
    const parent = await engine.launch("parent", {});
    parent.result.catch(() => undefined);
    const { ended } = await engine.retire(successor());
    await engine.cancel(parent.id);
    expect(await launched.promise).toBe(42);
    await ended;
  });

  describe("from a callback the engine runs for an active run", () => {
    /** A schema whose validation awaits `gate`, then launches `child` and passes its value on. */
    function launching(
      engine: Engine,
      gate: Promise<void>,
      entered?: () => void
    ) {
      return {
        "~standard": {
          validate: async () => {
            entered?.();
            await gate;
            return {
              value: await (await engine.launch<number>("child", {})).result,
            };
          },
          vendor: "test",
          version: 1 as const,
        },
      };
    }

    it("runs a child an output schema launches", async () => {
      const engine = engineHere();
      const gate = Promise.withResolvers<void>();
      engine.task({ name: "child", queue: "child", run: () => 42 });
      engine.define({
        fn: () => 1,
        kind: "step",
        name: "parent",
        output: launching(engine, gate.promise),
      });
      await engine.start();
      const parent = await engine.launch("parent", {});
      const { ended } = await engine.retire(successor());
      gate.resolve();
      expect(await outcome(parent.result)).toBe(42);
      await ended;
    });

    it("runs a child a step's input schema launches", async () => {
      const engine = engineHere();
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      engine.task({ name: "child", queue: "child", run: () => 42 });
      const inner = step("inner")
        .input(launching(engine, gate.promise, entered.resolve))
        .do(({ input }) => input);
      engine.define({
        kind: "workflow",
        name: "parent",
        setup: () => inner({}),
      });
      await engine.start();
      const parent = await engine.launch("parent", {});
      await entered.promise;
      const { ended } = await engine.retire(successor());
      gate.resolve();
      expect(await outcome(parent.result)).toBe(42);
      await ended;
    });

    it("runs a child a launch's input schema launches as the run starts", async () => {
      const engine = engineHere();
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const seen = Promise.withResolvers<unknown>();
      engine.task({ name: "child", queue: "child", run: () => 42 });
      engine.define({
        fn: () => "done",
        input: {
          "~standard": {
            validate: async (value: unknown) => {
              entered.resolve();
              await gate.promise;
              seen.resolve(
                await outcome(
                  engine
                    .launch<number>("child", {})
                    .then((child) => child.result)
                )
              );
              return { value };
            },
            vendor: "test",
            version: 1 as const,
          },
        },
        kind: "step",
        name: "parent",
      });
      await engine.start();
      const launching_ = engine.launch("parent", {});
      await entered.promise;
      const retiring = engine.retire(successor());
      gate.resolve();
      const parent = await launching_;
      expect(await seen.promise).toBe(42);
      expect(await outcome(parent.result)).toBe("done");
      await (await retiring).ended;
    });

    it("runs a child a workflow's setup launches", async () => {
      const engine = engineHere();
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const seen = Promise.withResolvers<unknown>();
      engine.task({ name: "child", queue: "child", run: () => 42 });
      const leaf = step("leaf").do(() => "done");
      engine.define({
        kind: "workflow",
        name: "parent",
        setup: async () => {
          entered.resolve();
          await gate.promise;
          seen.resolve(
            await outcome(
              engine.launch<number>("child", {}).then((child) => child.result)
            )
          );
          return leaf({});
        },
      });
      await engine.start();
      const launching_ = engine.launch("parent", {});
      await entered.promise;
      const retiring = engine.retire(successor());
      gate.resolve();
      const parent = await launching_;
      expect(await seen.promise).toBe(42);
      expect(await outcome(parent.result)).toBe("done");
      await (await retiring).ended;
    });

    it("runs a child a retry policy launches", async () => {
      const engine = engineHere();
      const gate = Promise.withResolvers<void>();
      const launched = Promise.withResolvers<unknown>();
      let attempts = 0;
      engine.task({ name: "child", queue: "child", run: () => 42 });
      engine.define({
        config: {
          retry: {
            maxAttempts: 2,
            shouldRetry: () => {
              launched.resolve(
                outcome(
                  engine
                    .launch<number>("child", {})
                    .then((child) => child.result)
                )
              );
              return true;
            },
          },
        },
        fn: async () => {
          attempts += 1;
          if (attempts === 1) {
            await gate.promise;
            throw new Error("first attempt fails");
          }
          return attempts;
        },
        kind: "step",
        name: "parent",
      });
      await engine.start();
      const parent = await engine.launch("parent", {});
      const { ended } = await engine.retire(successor());
      gate.resolve();
      expect(await launched.promise).toBe(42);
      expect(await outcome(parent.result)).toBe(2);
      await ended;
    });
  });

  it("resolves the retiring engine and its run for an authored call from an active run's callback, another engine of the workspace alive", async () => {
    const old = engineHere();
    const next = engineHere();
    const gate = Promise.withResolvers<void>();
    const child = step("child").do(() => 42);
    for (const engine of [old, next]) {
      engine.define(child);
      setHost(engine);
    }
    old.define({
      fn: () => 1,
      kind: "step",
      name: "parent",
      output: {
        "~standard": {
          validate: async () => {
            await gate.promise;
            return { value: await child.run({}) };
          },
          vendor: "test",
          version: 1 as const,
        },
      },
    });
    await old.start();
    await next.start();
    const parent = await old.launch("parent", {}, { queue: "parents" });
    const { ended } = await old.retire(successor());
    gate.resolve();
    expect(await outcome(parent.result)).toBe(42);
    expect(old.executions.list().some((run) => run.name === "child")).toBe(
      true
    );
    expect(next.executions.list().some((run) => run.name === "child")).toBe(
      false
    );
    await ended;
  });

  it("refuses a launch from an observer, and one after its active runs ended", async () => {
    const engine = engineHere();
    const observed = Promise.withResolvers<unknown>();
    const retired = Promise.withResolvers<void>();
    engine.task({ name: "child", run: () => 42 });
    engine.observe(TASKS, async () => {
      await retired.promise;
      observed.resolve(await outcome(engine.launch("child", {})));
    });
    await engine.start();
    await new Tasks({ store: engine.taskStore }).create({ title: "seen" });
    const retiring = engine.retire(successor());
    retired.resolve();
    expect(await observed.promise).toMatch(RETIRING);
    await retiring;
    expect(await outcome(engine.launch("child", {}))).toMatch(RETIRING);
  });

  it("does not count as ended while a child an active run launched still runs", async () => {
    const engine = engineHere();
    const childGate = Promise.withResolvers<void>();
    const parentGate = Promise.withResolvers<void>();
    let ended = false;
    engine.task({
      name: "child",
      queue: "child",
      run: async () => {
        await childGate.promise;
        return 42;
      },
    });
    engine.task({
      name: "parent",
      run: async () => {
        await parentGate.promise;
        // Launched, not awaited: the parent ends before its child does.
        await engine.launch("child", {});
      },
    });
    await engine.start();
    const parent = await engine.launch("parent", {});
    const retired = await engine.retire(successor());
    retired.ended.then(() => {
      ended = true;
    });
    parentGate.resolve();
    await parent.result;
    // Past two of the retirement's looks (every 250 ms) for what is left.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(ended).toBe(false);
    childGate.resolve();
    await retired.ended;
  });
});
