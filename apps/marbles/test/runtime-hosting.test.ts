import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Output } from "ai";
import { gc } from "bun";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { step } from "~/authoring/builder";
import { Catalog } from "~/authoring/catalog";
import { observe } from "~/authoring/observe";
import { runs } from "~/authoring/runs";
import type { InstanceRuntime, Scope } from "~/authoring/runtime";
import {
  captureScope,
  dispose,
  instanceRuntime,
  releaseEngine,
  setDefaultRuntime,
  setHost,
  withLoadScope,
} from "~/authoring/runtime";
import { tasks } from "~/authoring/tasks";
import type { StepRecord, WorkflowRecord } from "~/lib/definitions";
import { activeContext, inContext } from "~/lib/runs/context";
import { hostTasks } from "~/workspace/open";
import { startEngine } from "./helpers/engine";
import { seedRepository } from "./helpers/repository";

type TestEngine = InstanceRuntime & { disposed: boolean };

function engine(workspaceId: string): TestEngine {
  return {
    context: { cwd: "/", environment: {}, workspaceId },
    disposed: false,
    workspaceId,
  } as unknown as TestEngine;
}

function inRunOf<T>(owner: TestEngine, work: () => T): T {
  return inContext(owner.context, work);
}

async function reached(
  work: (call: () => unknown) => unknown
): Promise<unknown> {
  return await Promise.resolve()
    .then(() => work(instanceRuntime))
    .catch((error: Error) => error.name);
}

function replaced(workspace: string) {
  const old = new Catalog();
  const oldEngine = engine(workspace);
  setHost(oldEngine, old);
  const next = new Catalog();
  const nextEngine = engine(workspace);
  return {
    bindNext: () => setHost(nextEngine, next),
    next,
    nextEngine,
    old,
    oldEngine,
  };
}

it("keeps an old engine's runs on that engine after another is bound, until it is disposed", async () => {
  const w = replaced("old-still-runs");
  w.bindNext();
  expect(await reached((call) => inRunOf(w.oldEngine, call))).toBe(w.oldEngine);
  expect(await reached((call) => inRunOf(w.nextEngine, call))).toBe(
    w.nextEngine
  );

  w.oldEngine.disposed = true;
  expect(await reached((call) => inRunOf(w.oldEngine, call))).toBe(
    "WorkspaceReleasedError"
  );
  expect(await reached((call) => inRunOf(w.nextEngine, call))).toBe(
    w.nextEngine
  );
});

it("refuses a continuation of an old run that resumes once its engine is disposed and replaced", async () => {
  const w = replaced("continuation");
  const { promise: gate, resolve: open } = Promise.withResolvers<undefined>();
  const resumed = inRunOf(w.oldEngine, async () => {
    await gate;
    return await reached((call) => call());
  });
  w.bindNext();
  w.oldEngine.disposed = true;
  open(undefined);
  expect(await resumed).toBe("WorkspaceReleasedError");
});

it("gives a scope an old run captures after another engine is bound the old engine, until it is disposed", async () => {
  const w = replaced("late-capture");
  w.bindNext();
  const late: Scope = inRunOf(w.oldEngine, captureScope);
  expect(await reached((call) => late(call))).toBe(w.oldEngine);
  w.oldEngine.disposed = true;
  expect(await reached((call) => late(call))).toBe("WorkspaceReleasedError");
});

it("keeps an old run's timers and promises on its engine while it lives, and refuses them once it is disposed", async () => {
  const w = replaced("timers");
  const { promise: firstGate, resolve: openFirst } =
    Promise.withResolvers<undefined>();
  const { promise: secondGate, resolve: openSecond } =
    Promise.withResolvers<undefined>();
  const { promise: firstTimer, resolve: fireFirst } =
    Promise.withResolvers<undefined>();
  const { promise: secondTimer, resolve: fireSecond } =
    Promise.withResolvers<undefined>();
  const outcomes = inRunOf(w.oldEngine, () => {
    const timed = (fire: Promise<undefined>) =>
      new Promise<unknown>((settle) => {
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
  openFirst(undefined);
  fireFirst(undefined);
  expect(await outcomes.firstPromise).toBe(w.oldEngine);
  expect(await outcomes.firstTimer).toBe(w.oldEngine);
  w.oldEngine.disposed = true;
  openSecond(undefined);
  fireSecond(undefined);
  expect(await outcomes.secondPromise).toBe("WorkspaceReleasedError");
  expect(await outcomes.secondTimer).toBe("WorkspaceReleasedError");
});

describe("two real engines over one workspace", () => {
  afterEach(async () => {
    await dispose();
  });

  it("keep an old engine's step and observer on that engine after a new one is bound, until it is disposed", async () => {
    const workspaceId = "real-replacement";
    const alive = Promise.withResolvers<undefined>();
    const late = Promise.withResolvers<undefined>();
    const seen: Record<string, unknown> = {};
    const probe = async () =>
      await instanceRuntime().catch((error: Error) => error.name);
    const probeStep = step("probe").do(async () => {
      await alive.promise;
      seen.stepAlive = await probe();
      seen.stepLate = late.promise.then(probe);
      return "done";
    });
    const watcherObs = observe(tasks, async function watcher() {
      await alive.promise;
      seen.observerAlive = await probe();
      seen.observerLate = late.promise.then(probe);
    });
    const root = await mkdtemp(join(tmpdir(), "marbles-real-replacement-"));
    try {
      const old = await startEngine({
        collect: { probeStep, watcher: watcherObs },
        print: () => undefined,
        root,
        workspaceId,
      });
      const oldCatalog = new Catalog();
      setHost(old, oldCatalog);
      const running = old.run("probe", undefined);
      await hostTasks(old).create({ title: "observed" });
      const next = await startEngine({
        collect: { probeStep, watcher: watcherObs },
        print: () => undefined,
        root,
        workspaceId,
      });
      const nextCatalog = new Catalog();
      setHost(next, nextCatalog);
      alive.resolve(undefined);
      expect(await running).toBe("done");
      await vi.waitFor(() => expect(seen.observerAlive).toBeDefined());
      expect(seen.stepAlive).toBe(old);
      expect(seen.observerAlive).toBe(old);

      await old.dispose();
      late.resolve(undefined);
      expect(await seen.stepLate).toBe("WorkspaceReleasedError");
      expect(await seen.observerLate).toBe("WorkspaceReleasedError");
      await next.dispose();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

async function reachedEngine(): Promise<unknown> {
  return await instanceRuntime().catch((error: Error) => error.name);
}

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
  });

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
          prompt: "",
          settings: {
            output: Output.object({
              schema: z.object({ answer: z.number() }).refine(async () => {
                seen.push(await reachedEngine());
                return true;
              }),
            }),
          },
        });
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
    expect(seen.map(which)).toEqual(["next", "next", "next", "next"]);
  });

  it("refuses a run of an engine no host bound that names a workspace another engine is bound to", async () => {
    await using engines = await replacedEngines("unbound-run");
    await engines.old.dispose();
    const stranger = engine("unbound-run");
    await expect(inRunOf(stranger, () => instanceRuntime())).rejects.toThrow(
      expect.objectContaining({ name: "AmbiguousWorkspaceError" })
    );
  });
});

describe("load-time routing and cross-workspace isolation", () => {
  afterEach(async () => {
    await dispose();
  });

  it("refuses tasks, runs, enqueue, run, and instanceRuntime during source load and never falls through to another workspace or fallback runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "marbles-load-refusal-"));
    const fallbackCalled = vi.fn(() => Promise.reject(new Error("fallback")));
    setDefaultRuntime(fallbackCalled);
    const engineB = await startEngine({
      print: () => undefined,
      root,
      workspaceId: "ws-b",
    });
    setHost(engineB, new Catalog());
    try {
      const loadingStep = step("top-level-during-load").do(() => "ran");
      await withLoadScope({ workspaceId: "ws-a" }, async () => {
        await expect(tasks.list()).rejects.toThrow(
          "workspace ws-a: tasks is not available while its source loads"
        );
        await expect(runs.list()).rejects.toThrow(
          "workspace ws-a: runs.list() is not available while its source loads"
        );
        await expect(step.enqueue("top-level-during-load")).rejects.toThrow(
          "workspace ws-a: step.enqueue() is not available while its source loads"
        );
        await expect(loadingStep.enqueue()).rejects.toThrow(
          "workspace ws-a: runtime is not available while its source loads"
        );
        await expect(loadingStep.run()).rejects.toThrow(
          "workspace ws-a: runtime is not available while its source loads"
        );
        await expect(instanceRuntime()).rejects.toThrow(
          "workspace ws-a: runtime is not available while its source loads"
        );
      });
      expect(fallbackCalled).not.toHaveBeenCalled();
    } finally {
      await engineB.dispose();
      releaseEngine(engineB);
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps workspace B's running step routed to engine B while workspace A's source loads concurrently", async () => {
    const root = await mkdtemp(join(tmpdir(), "marbles-concurrent-load-"));
    const startedLoad = Promise.withResolvers<undefined>();
    const finishLoad = Promise.withResolvers<undefined>();
    const engineB = await startEngine({
      print: () => undefined,
      root,
      workspaceId: "ws-b-live",
    });
    setHost(engineB, new Catalog());
    try {
      await hostTasks(engineB).create({ title: "from-b" });
      const loadingA = withLoadScope(
        { workspaceId: "ws-a-loading" },
        async () => {
          startedLoad.resolve(undefined);
          await finishLoad.promise;
        }
      );
      await startedLoad.promise;
      const seenInB = await inRunOf(
        engineB as unknown as TestEngine,
        async () => {
          const listed = await tasks.list();
          const runtime = await instanceRuntime();
          const runViews = await runs.list();
          return {
            listed: listed.items.map((item) => item.title),
            runCount: runViews.length,
            runtime,
          };
        }
      );
      finishLoad.resolve(undefined);
      await loadingA;
      expect(seenInB.listed).toEqual(["from-b"]);
      expect(seenInB.runtime).toBe(engineB);
      expect(seenInB.runCount).toBe(0);
    } finally {
      finishLoad.resolve(undefined);
      await engineB.dispose();
      releaseEngine(engineB);
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("what a disposed engine leaves behind", () => {
  it("lets an engine go as its host releases it, though nothing is bound after it", async () => {
    const workspace = "released-alone";
    const engines: WeakRef<object>[] = [];
    (() => {
      const loaded = new Catalog();
      const bound = engine(workspace);
      setHost(bound, loaded);
      bound.disposed = true;
      releaseEngine(bound);
      engines.push(new WeakRef(bound));
    })();
    for (let each = 0; each < 4; each += 1) {
      await new Promise((settle) => setTimeout(settle, 0));
      gc(true);
    }
    expect(engines.filter((ref) => ref.deref() !== undefined)).toHaveLength(0);
  });

  it("lets every disposed engine and its catalog go and refuses their captured scopes' late calls", async () => {
    const workspace = "leak-probe";
    const engines: WeakRef<object>[] = [];
    const catalogs: WeakRef<object>[] = [];
    const lateScopes: Scope[] = [];
    for (let each = 0; each < 32; each += 1) {
      lateScopes.push(
        reloaded(workspace, (bound, loaded) => {
          engines.push(new WeakRef(bound));
          catalogs.push(new WeakRef(loaded));
        })
      );
    }
    setHost(engine(workspace), new Catalog());
    for (let each = 0; each < 4; each += 1) {
      await new Promise((settle) => setTimeout(settle, 0));
      gc(true);
    }
    expect(engines.filter((ref) => ref.deref() !== undefined)).toHaveLength(0);
    expect(catalogs.filter((ref) => ref.deref() !== undefined)).toHaveLength(0);
    for (const late of lateScopes) {
      await expect(late(instanceRuntime)).rejects.toThrow(
        expect.objectContaining({ name: "WorkspaceReleasedError" })
      );
    }
  });
});

function reloaded(
  workspace: string,
  watch: (bound: object, loaded: object) => void
): Scope {
  const loaded = new Catalog();
  const bound = engine(workspace);
  setHost(bound, loaded);
  const scope = inRunOf(bound, captureScope);
  bound.disposed = true;
  watch(bound, loaded);
  return scope;
}
