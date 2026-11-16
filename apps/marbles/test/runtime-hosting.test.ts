/**
 * Which engine a workspace's own code answers to (`authoring/runtime.ts`):
 * the engine its run, observer or load belongs to, until that engine is
 * disposed, whatever engine is bound to the workspace after it; then it
 * is refused. Never the engine bound after it.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Output } from "ai";
import { gc } from "bun";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { step } from "~/authoring/builder";
import { Catalog, catalog } from "~/authoring/catalog";
import { observe } from "~/authoring/observe";
import type { InstanceRuntime, Scope } from "~/authoring/runtime";
import {
  abandonHost,
  captureScope,
  declaringCatalog,
  dispose,
  inLoad,
  instanceRuntime,
  loadInto,
  releaseEngine,
  setHost,
} from "~/authoring/runtime";
import { tasks } from "~/authoring/tasks";
import type { StepRecord, WorkflowRecord } from "~/lib/definition";
import { activeContext, inContext } from "~/lib/execution-context";
import { hostTasks } from "~/workspace/open";
import { startEngine } from "./helpers/engine";
import { seedRepository } from "./helpers/repository";

type TestEngine = InstanceRuntime & { disposed: boolean };

/** An engine as the slot sees it: its workspace, the context its runs execute in, and whether it was disposed. */
function engine(workspaceId: string): TestEngine {
  return {
    context: { cwd: "/", environment: {}, workspaceId },
    disposed: false,
    workspaceId,
  } as unknown as TestEngine;
}

/** Load `workspaceId` into `into`; resolves the load's number. */
async function load(workspaceId: string, into: Catalog): Promise<number> {
  let number = 0;
  await loadInto(workspaceId, into, (n) => {
    number = n;
    return Promise.resolve();
  });
  return number;
}

/** Run `work` as one of `owner`'s runs would: in its execution context. */
function inRunOf<T>(owner: TestEngine, work: () => T): T {
  return inContext(owner.context, work);
}

const RELEASED = expect.objectContaining({ name: "WorkspaceReleasedError" });

/** What `work` declares into and reaches, or the name of what it threw. */
async function reached(
  work: (call: () => unknown) => unknown
): Promise<{ catalog: unknown; runtime: unknown }> {
  const declaredInto = await Promise.resolve()
    .then(() => work(declaringCatalog))
    .catch((error: Error) => error.name);
  const runtime = await Promise.resolve()
    .then(() => work(instanceRuntime))
    .catch((error: Error) => error.name);
  return { catalog: declaredInto, runtime };
}

/** A workspace with a first engine bound, then a second bound while the first still runs. */
async function replaced(workspace: string) {
  const old = new Catalog();
  const first = await load(workspace, old);
  const oldEngine = engine(workspace);
  setHost(oldEngine, old);
  const next = new Catalog();
  const second = await load(workspace, next);
  const nextEngine = engine(workspace);
  return {
    bindNext: () => setHost(nextEngine, next),
    first,
    next,
    nextEngine,
    old,
    oldEngine,
    second,
  };
}

it("keeps an old engine's runs and loads on that engine after another is bound, until it is disposed", async () => {
  const w = await replaced("old-still-runs");
  w.bindNext();
  // The old engine still finishes the runs it has: they answer to it.
  expect(await reached((call) => inRunOf(w.oldEngine, call))).toEqual({
    catalog: w.old,
    runtime: w.oldEngine,
  });
  expect(await reached((call) => inLoad(w.first, call))).toEqual({
    catalog: w.old,
    runtime: w.oldEngine,
  });
  // The new engine's own work reaches it.
  expect(await reached((call) => inRunOf(w.nextEngine, call))).toEqual({
    catalog: w.next,
    runtime: w.nextEngine,
  });
  expect(await reached((call) => inLoad(w.second, call))).toEqual({
    catalog: w.next,
    runtime: w.nextEngine,
  });

  w.oldEngine.disposed = true;
  // Disposed: refused, never handed to the engine bound after it.
  expect(await reached((call) => inRunOf(w.oldEngine, call))).toEqual({
    catalog: "WorkspaceReleasedError",
    runtime: "WorkspaceReleasedError",
  });
  expect(await reached((call) => inLoad(w.first, call))).toEqual({
    catalog: "WorkspaceReleasedError",
    runtime: "WorkspaceReleasedError",
  });
  expect(await reached((call) => inLoad(w.second, call))).toEqual({
    catalog: w.next,
    runtime: w.nextEngine,
  });
});

it("refuses a continuation of an old run that resumes once its engine is disposed and replaced", async () => {
  const w = await replaced("continuation");
  const { promise: gate, resolve: open } = Promise.withResolvers<undefined>();
  const resumed = inRunOf(w.oldEngine, async () => {
    await gate;
    return await reached((call) => call());
  });
  w.bindNext();
  w.oldEngine.disposed = true;
  open(undefined);
  expect(await resumed).toEqual({
    catalog: "WorkspaceReleasedError",
    runtime: "WorkspaceReleasedError",
  });
});

it("gives a scope an old run captures after another engine is bound the old engine, until it is disposed", async () => {
  const w = await replaced("late-capture");
  w.bindNext();
  const late: Scope = inRunOf(w.oldEngine, captureScope);
  expect(await reached((call) => late(call))).toEqual({
    catalog: w.old,
    runtime: w.oldEngine,
  });
  w.oldEngine.disposed = true;
  expect(await reached((call) => late(call))).toEqual({
    catalog: "WorkspaceReleasedError",
    runtime: "WorkspaceReleasedError",
  });
});

it("gives a scope captured while a load ran the engine that took that load", async () => {
  const workspace = "load-capture";
  const old = new Catalog();
  let made: Scope | undefined;
  await loadInto(workspace, old, (n) => {
    made = inLoad(n, captureScope);
    return Promise.resolve();
  });
  const oldEngine = engine(workspace);
  setHost(oldEngine, old);
  const next = new Catalog();
  await load(workspace, next);
  setHost(engine(workspace), next);
  const scope = made as Scope;
  expect(await reached((call) => scope(call))).toEqual({
    catalog: old,
    runtime: oldEngine,
  });
  oldEngine.disposed = true;
  expect(() => scope(declaringCatalog)).toThrow(RELEASED);
});

it("keeps an old run's timers and promises on its engine while it lives, and refuses them once it is disposed", async () => {
  const w = await replaced("timers");
  const { promise: firstGate, resolve: openFirst } =
    Promise.withResolvers<undefined>();
  const { promise: secondGate, resolve: openSecond } =
    Promise.withResolvers<undefined>();
  const { promise: firstTimer, resolve: fireFirst } =
    Promise.withResolvers<undefined>();
  const { promise: secondTimer, resolve: fireSecond } =
    Promise.withResolvers<undefined>();
  // Set up inside the old run: each runs later, as a timer or promise of
  // that run would.
  const outcomes = inRunOf(w.oldEngine, () => {
    const timed = (fire: Promise<undefined>) =>
      new Promise<{ catalog: unknown; runtime: unknown }>((settle) => {
        fire.then(
          () =>
            setTimeout(() => {
              settle(reached((call) => call()));
            }, 1),
          () => undefined
        );
      });
    return {
      firstPromise: firstGate.then(() => reached((call) => call())),
      firstTimer: timed(firstTimer),
      secondPromise: secondGate.then(() => reached((call) => call())),
      secondTimer: timed(secondTimer),
    };
  });
  w.bindNext();
  // After the replacement, before the old engine is disposed.
  openFirst(undefined);
  fireFirst(undefined);
  const alive = { catalog: w.old, runtime: w.oldEngine };
  expect(await outcomes.firstPromise).toEqual(alive);
  expect(await outcomes.firstTimer).toEqual(alive);
  // Once it is disposed.
  w.oldEngine.disposed = true;
  openSecond(undefined);
  fireSecond(undefined);
  const refused = {
    catalog: "WorkspaceReleasedError",
    runtime: "WorkspaceReleasedError",
  };
  expect(await outcomes.secondPromise).toEqual(refused);
  expect(await outcomes.secondTimer).toEqual(refused);
});

it("refuses a load its host gave up while an older engine still answers, and leaves that engine answering its own", async () => {
  const w = await replaced("given-up");
  // The second load completed, and its host gave it up before binding it.
  abandonHost("given-up", w.next);
  expect(await reached((call) => inLoad(w.second, call))).toEqual({
    catalog: "WorkspaceReleasedError",
    runtime: "WorkspaceReleasedError",
  });
  expect(await reached((call) => inLoad(w.first, call))).toEqual({
    catalog: w.old,
    runtime: w.oldEngine,
  });
  expect(await reached((call) => inRunOf(w.oldEngine, call))).toEqual({
    catalog: w.old,
    runtime: w.oldEngine,
  });
});

it("refuses a first load's late work once its engine closed, though the workspace is hosted again", async () => {
  const workspace = "hosted-again";
  const old = new Catalog();
  const first = await load(workspace, old);
  const firstEngine = engine(workspace);
  setHost(firstEngine, old);
  firstEngine.disposed = true;
  expect(() => inLoad(first, declaringCatalog)).toThrow(RELEASED);

  const next = new Catalog();
  const second = await load(workspace, next);
  const secondEngine = engine(workspace);
  setHost(secondEngine, next);
  expect(() => inLoad(first, declaringCatalog)).toThrow(RELEASED);
  await expect(inLoad(first, instanceRuntime)).rejects.toThrow(RELEASED);
  expect(inLoad(second, declaringCatalog)).toBe(next);
  expect(await inLoad(second, instanceRuntime)).toBe(secondEngine);
});

describe("two real engines over one workspace", () => {
  afterEach(async () => {
    await dispose();
    catalog.reset();
  });

  it("keep an old engine's step and observer on that engine after a new one is bound, until it is disposed", async () => {
    const workspaceId = "real-replacement";
    const alive = Promise.withResolvers<undefined>();
    const late = Promise.withResolvers<undefined>();
    const seen: Record<string, unknown> = {};
    /** What the calling work declares into and reaches, by identity. */
    const probe = async () => ({
      catalog: (() => {
        try {
          return declaringCatalog();
        } catch (error) {
          return (error as Error).name;
        }
      })(),
      runtime: await instanceRuntime().catch((error: Error) => error.name),
    });
    step("probe").do(async () => {
      await alive.promise;
      seen.stepAlive = await probe();
      // Left running after the step returns, as a timer of its run would.
      seen.stepLate = late.promise.then(probe);
      return "done";
    });
    observe(tasks, async () => {
      await alive.promise;
      seen.observerAlive = await probe();
      seen.observerLate = late.promise.then(probe);
    });
    const root = await mkdtemp(join(tmpdir(), "marbles-real-replacement-"));
    try {
      const old = await startEngine({
        print: () => undefined,
        root,
        workspaceId,
      });
      const oldCatalog = new Catalog();
      setHost(old, oldCatalog);
      const running = old.run("probe", undefined);
      await hostTasks(old).create({ title: "observed" });
      const next = await startEngine({
        print: () => undefined,
        root,
        workspaceId,
      });
      const nextCatalog = new Catalog();
      setHost(next, nextCatalog);
      alive.resolve(undefined);
      expect(await running).toBe("done");
      await vi.waitFor(() => expect(seen.observerAlive).toBeDefined());
      const oldAnswers = { catalog: oldCatalog, runtime: old };
      expect(seen.stepAlive).toEqual(oldAnswers);
      expect(seen.observerAlive).toEqual(oldAnswers);

      await old.dispose();
      late.resolve(undefined);
      const refused = {
        catalog: "WorkspaceReleasedError",
        runtime: "WorkspaceReleasedError",
      };
      expect(await seen.stepLate).toEqual(refused);
      expect(await seen.observerLate).toEqual(refused);
      await next.dispose();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

/** What the calling authored code reaches: the engine, or the name of what it threw. */
async function reachedEngine(): Promise<unknown> {
  return await instanceRuntime().catch((error: Error) => error.name);
}

/** A schema whose check is an author's code, recording what it reaches. */
function probingSchema(seen: unknown[]): StandardSchemaV1 {
  return {
    "~standard": {
      validate: async (value: unknown) => {
        seen.push(await reachedEngine());
        return { value };
      },
      vendor: "test",
      version: 1,
    },
  };
}

describe("every place an engine calls an author's code", () => {
  afterEach(async () => {
    await dispose();
    catalog.reset();
  });

  /** A first engine and its replacement over one workspace, both alive. */
  async function replacedEngines(workspaceId: string) {
    const root = await seedRepository();
    const old = await startEngine({
      print: () => undefined,
      root,
      workspaceId,
    });
    setHost(old, new Catalog());
    const next = await startEngine({
      print: () => undefined,
      root,
      workspaceId,
    });
    setHost(next, new Catalog());
    return {
      [Symbol.asyncDispose]: async () => {
        await old.dispose();
        await next.dispose();
        await rm(root, { force: true, recursive: true });
      },
      next,
      old,
    };
  }

  it("runs a host task's body as its engine's work, before and after a replacement is bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "marbles-task-owner-"));
    const workspaceId = "task-owner";
    const old = await startEngine({
      print: () => undefined,
      root,
      workspaceId,
    });
    const next = await startEngine({
      print: () => undefined,
      root,
      workspaceId,
    });
    const started = Promise.withResolvers<undefined>();
    const held = Promise.withResolvers<undefined>();
    old.task({
      name: "probe",
      run: async () => {
        started.resolve(undefined);
        await held.promise;
        return { context: activeContext(), reached: await reachedEngine() };
      },
    });
    setHost(old, new Catalog());
    try {
      const running = old.run<{ context: unknown; reached: unknown }>(
        "probe",
        undefined
      );
      await started.promise;
      setHost(next, new Catalog());
      held.resolve(undefined);
      const got = await running;
      expect(got.context).toBe(old.context);
      expect(got.reached).toBe(old);
    } finally {
      held.resolve(undefined);
      await old.dispose();
      await next.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("runs a workflow's setup, a step's input and output schemas and its retry decision as its engine's work", async () => {
    await using engines = await replacedEngines("entry-points");
    const { old } = engines;
    const seen: Record<
      "input" | "launch" | "output" | "retry" | "setup",
      unknown[]
    > = {
      input: [],
      launch: [],
      output: [],
      retry: [],
      setup: [],
    };
    let attempts = 0;
    const inner: StepRecord = {
      config: {
        retry: {
          maxAttempts: 2,
          shouldRetry: () => {
            seen.retry.push("asked");
            return true;
          },
        },
      },
      fn: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("first attempt fails");
        }
        return "done";
      },
      input: probingSchema(seen.input),
      kind: "step",
      name: "inner",
      output: probingSchema(seen.output),
    };
    const parent: StepRecord = {
      fn: ({ input }) => (input as { inner: unknown }).inner,
      kind: "step",
      name: "parent",
    };
    const flow: WorkflowRecord = {
      input: probingSchema(seen.launch),
      kind: "workflow",
      name: "flow",
      setup: async () => {
        seen.setup.push(await reachedEngine());
        // A child's input is checked as it runs; a root's was at launch.
        return {
          children: [
            [
              "inner",
              {
                children: [],
                definition: inner,
                kind: "node",
                literal: {},
                mode: "series",
              },
            ],
          ],
          definition: parent,
          kind: "node",
          literal: {},
          mode: "series",
        };
      },
    };
    old.define(flow);
    const reachedAtRetry: unknown[] = [];
    const decide = inner.config?.retry?.shouldRetry;
    // The retry decision records what it reaches, then decides.
    (inner.config?.retry as { shouldRetry: unknown }).shouldRetry = (
      error: unknown,
      attempt: number
    ) => {
      reachedAtRetry.push(
        activeContext() === old.context ? old : "not the engine's work"
      );
      return decide?.(error, attempt) ?? false;
    };
    expect(await old.run("flow", undefined)).toBe("done");
    // By identity: the engine itself is no value to compare.
    const which = (each: unknown) => {
      if (each === old) {
        return "old";
      }
      return each === engines.next ? "next" : each;
    };
    expect({
      input: seen.input.map(which),
      launch: seen.launch.map(which),
      output: seen.output.map(which),
      retry: reachedAtRetry.map(which),
      setup: seen.setup.map(which),
    }).toEqual({
      // Once per attempt.
      input: ["old", "old"],
      launch: ["old"],
      output: ["old"],
      retry: ["old"],
      setup: ["old"],
    });
  });

  it("runs an agent's own callbacks in a turn a task started as that task's engine's work", async () => {
    await using engines = await replacedEngines("turn-callbacks");
    const { old } = engines;
    const seen: unknown[] = [];
    old.task({
      name: "turn",
      run: async (_input, context) => {
        const session = await context.agents.session({
          id: "prober",
          kind: "agent",
          // The mock models answer with the prompts: only the JSON below.
          prompt: "",
          settings: {
            // The author's schema for the turn's answer, which the turn
            // parses it with.
            output: Output.object({
              schema: z.object({ answer: z.number() }).refine(async () => {
                seen.push(await reachedEngine());
                return true;
              }),
            }),
          },
        });
        // The mock models answer with the prompt: plain JSON here.
        await session.generate('{"answer":1}');
        return "turned";
      },
    });
    expect(await old.run("turn", undefined)).toBe("turned");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((each) => each === old)).toBe(true);
  });

  it("runs work one engine's step starts on another as that other engine's, not the step's", async () => {
    await using engines = await replacedEngines("cross-engine");
    const { next, old } = engines;
    const seen: unknown[] = [];
    next.task({
      name: "probe",
      run: async () => {
        seen.push(activeContext() === next.context ? next : "not next's work");
        seen.push(await reachedEngine());
        return "task";
      },
    });
    const leaf: StepRecord = { fn: () => "leaf", kind: "step", name: "leaf" };
    next.define({
      input: probingSchema(seen),
      kind: "workflow",
      name: "flow-on-next",
      setup: async () => {
        seen.push(await reachedEngine());
        return {
          children: [],
          definition: leaf,
          kind: "node",
          literal: {},
          mode: "series",
          parsed: true,
        };
      },
    });
    old.define({
      fn: async () => {
        await next.run("probe", undefined);
        await next.run("flow-on-next", undefined);
        return "crossed";
      },
      kind: "step",
      name: "cross",
    });
    expect(await old.run("cross", undefined)).toBe("crossed");
    const which = (each: unknown) => {
      if (each === next) {
        return "next";
      }
      return each === old ? "old" : each;
    };
    // The task's context and engine, the workflow's input schema and setup.
    expect(seen.map(which)).toEqual(["next", "next", "next", "next"]);
  });

  it("refuses a load no engine took yet while two engines of its workspace are alive, rather than hand it to the one bound last", async () => {
    await using engines = await replacedEngines("two-alive");
    const loading = await load("two-alive", new Catalog());
    await expect(inLoad(loading, instanceRuntime)).rejects.toThrow(
      expect.objectContaining({ name: "AmbiguousWorkspaceError" })
    );
    await engines.old.dispose();
    // One alive: the load reaches it, as a source loading beside it does.
    expect(await inLoad(loading, instanceRuntime)).toBe(engines.next);
  });

  it("refuses a run of an engine no host bound that names a workspace another engine is bound to", async () => {
    await using engines = await replacedEngines("unbound-run");
    await engines.old.dispose();
    const stranger = engine("unbound-run");
    await expect(inRunOf(stranger, () => instanceRuntime())).rejects.toThrow(
      expect.objectContaining({ name: "AmbiguousWorkspaceError" })
    );
    expect(() => inRunOf(stranger, declaringCatalog)).toThrow(
      expect.objectContaining({ name: "AmbiguousWorkspaceError" })
    );
  });
});

describe("what a disposed engine leaves behind", () => {
  it("lets an engine go as its host releases it, though nothing is bound after it", async () => {
    const workspace = "released-alone";
    const engines: WeakRef<object>[] = [];
    await (async () => {
      const loaded = new Catalog();
      await load(workspace, loaded);
      const bound = engine(workspace);
      setHost(bound, loaded);
      bound.disposed = true;
      // What a host does once its engine is disposed.
      releaseEngine(bound);
      engines.push(new WeakRef(bound));
    })();
    for (let each = 0; each < 4; each += 1) {
      await new Promise((settle) => setTimeout(settle, 0));
      gc(true);
    }
    expect(engines.filter((ref) => ref.deref() !== undefined)).toHaveLength(0);
  });

  it("lets every disposed engine and its catalog go, however many loads came before, and refuses their loads' late calls", async () => {
    const workspace = "leak-probe";
    const engines: WeakRef<object>[] = [];
    const catalogs: WeakRef<object>[] = [];
    const lateCalls: (() => unknown)[] = [];
    for (let each = 0; each < 32; each += 1) {
      lateCalls.push(
        ...(await reloaded(workspace, (bound, loaded) => {
          engines.push(new WeakRef(bound));
          catalogs.push(new WeakRef(loaded));
        }))
      );
    }
    // The engine bound last is replaced too; nothing else keeps them.
    setHost(engine(workspace), new Catalog());
    for (let each = 0; each < 4; each += 1) {
      await new Promise((settle) => setTimeout(settle, 0));
      gc(true);
    }
    expect(engines.filter((ref) => ref.deref() !== undefined)).toHaveLength(0);
    expect(catalogs.filter((ref) => ref.deref() !== undefined)).toHaveLength(0);
    for (const late of lateCalls) {
      expect(late).toThrow(RELEASED);
    }
  });
});

/**
 * Load `workspace`, bind an engine to the load, keep what work of it might
 * keep (the load's number, a scope one of its runs captured), and dispose
 * the engine. Resolves the late calls, which close over neither.
 */
async function reloaded(
  workspace: string,
  watch: (bound: object, loaded: object) => void
): Promise<(() => unknown)[]> {
  const loaded = new Catalog();
  const number = await load(workspace, loaded);
  const bound = engine(workspace);
  setHost(bound, loaded);
  const scope = inRunOf(bound, captureScope);
  bound.disposed = true;
  watch(bound, loaded);
  return lateCallsOf(number, scope);
}

function lateCallsOf(number: number, scope: Scope): (() => unknown)[] {
  return [
    () => inLoad(number, declaringCatalog),
    () => scope(declaringCatalog),
  ];
}
