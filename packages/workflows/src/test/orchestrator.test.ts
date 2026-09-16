/**
 * Orchestrator — Stage 4 / P0-1 + P0-2: Registry + name-based dispatch +
 * lifecycle passthrough + cold-start recover wiring.
 *
 * Four describe blocks:
 *   A. Registry — register / resolve / has / names + duplicate-name semantics
 *   B. Orchestrator.run — name-based dispatch, persisted runs.step uses the
 *      registered name, Step factory auto-wraps into Workflow
 *   C. Lifecycle — setup/start/stop plus Queue passthrough behavior
 *   D. Startup recovery — preflight→build→seed→adopt before serving, with
 *      skip-on-complete via pre-seeded metadata
 */

import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import {
  DefinitionNotRegisteredError,
  OrchestratorNotStartedError,
  RecoverableDefinitionMissingError,
} from "../errors";
import type { Factory, RunExecutionContext } from "../orchestrator";
import { Orchestrator, Registry } from "../orchestrator";
import { Step } from "../step";
import { Workflow } from "../workflow";
import { makeOrchestratorConfig } from "./helpers/config";
import { makeInMemoryStore } from "./helpers/store";

const store = makeInMemoryStore();

function requireRun<T>(run: T | null): T {
  if (!run) {
    throw new Error("expected persisted run");
  }
  return run;
}

// ════════════════════════════════════════════════════════════════════════════
// A. Registry
// ════════════════════════════════════════════════════════════════════════════

describe("Registry — register / resolve / has / names", () => {
  test("register adds a factory; has returns true; names includes it", () => {
    const registry = new Registry();
    const factory: Factory<string, string> = (input) =>
      Workflow.create({ execute: async (i) => i, input, name: "echo" });
    registry.register("echo", factory);
    expect(registry.has("echo")).toBe(true);
    expect(registry.names()).toContain("echo");
  });

  test("register throws on duplicate name", () => {
    const registry = new Registry();
    const factory: Factory<string, string> = (input) =>
      Workflow.create({ execute: async (i) => i, input, name: "x" });
    registry.register("dup", factory);
    expect(() => {
      registry.register("dup", factory);
    }).toThrow(/already registered/i);
  });

  test("resolve returns the registered factory; calling it produces the runnable", async () => {
    const registry = new Registry();
    const factory: Factory<string, string> = (input) =>
      Workflow.create({ execute: async (i) => i, input, name: "echo" });
    registry.register("echo2", factory);
    const resolved = registry.resolve<string, string>("echo2");
    const wf = await resolved("hello");
    expect(wf.kind).toBe("workflow");
    if (wf.kind !== "workflow") {
      throw new Error("expected workflow");
    }
    const value = await wf.run();
    expect(value).toBe("hello");
  });

  test("resolve throws on missing name", () => {
    const registry = new Registry();
    expect(() => registry.resolve("nope")).toThrow(/not registered/i);
  });

  test("Step and Workflow factories share one namespace", () => {
    const registry = new Registry();
    const stepFactory: Factory<void, string> = () =>
      Step.from("inner", async () => "x");
    const wfFactory: Factory<void, string> = () =>
      Workflow.create<void, string>({
        execute: async () => "x",
        input: undefined,
        name: "inner",
      });
    registry.register("shared", stepFactory);
    expect(() => {
      registry.register("shared", wfFactory);
    }).toThrow(/already registered/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B. Orchestrator.run — dispatch by name
// ════════════════════════════════════════════════════════════════════════════

describe("Orchestrator.run — dispatch by name", () => {
  test("allocates identity and links before building a direct Run", async () => {
    const localStore = makeInMemoryStore();
    const orch = new Orchestrator({
      config: makeOrchestratorConfig(),
      store: localStore,
    });
    await orch.setup();
    let observedContext: RunExecutionContext | null = null;
    orch.register<string, string>("linked-run", (input, context) => {
      if (!context) {
        throw new Error("expected Run execution context");
      }
      observedContext = context;
      return Workflow.create({
        execute: async (value) => value,
        input,
        name: "linked-internal",
      });
    });
    await orch.start();

    const dispatched = await orch.run("linked-run", "hello", {
      links: {
        principalId: "user-1",
        sessionId: "session-1",
        subjectId: "document-1",
      },
    });
    await dispatched.result();
    const record = requireRun(await localStore.getRun(dispatched.id));

    expect(observedContext).toMatchObject({
      definition: { name: "linked-run" },
      links: {
        principalId: "user-1",
        sessionId: "session-1",
        subjectId: "document-1",
      },
      runId: dispatched.id,
    });
    expect(
      (observedContext as RunExecutionContext | null)?.emitOutput
    ).toBeTypeOf("function");
    expect(
      (observedContext as RunExecutionContext | null)?.claimEffect
    ).toBeTypeOf("function");
    expect(record).toMatchObject({
      definition: { name: "linked-run" },
      id: dispatched.id,
      links: {
        principalId: "user-1",
        sessionId: "session-1",
        subjectId: "document-1",
      },
    });
    expect((await localStore.listJobs()).items).toEqual([]);
    await orch.stop();
  });

  test("registered Workflow factory runs end-to-end", async () => {
    const orch = new Orchestrator({
      config: makeOrchestratorConfig(),
      store,
    });
    await orch.setup();
    orch.register<string, string>("rt-wf", (input) =>
      Workflow.create({ execute: async (i) => i, input, name: "wf-internal" })
    );
    await orch.start();
    const settled = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const d = yield* Effect.promise(() =>
            orch.run<string, string>("rt-wf", "hi")
          );
          return yield* Effect.promise(() => d.result());
        })
      )
    );
    expect((settled as { status: string; value?: string }).status).toBe(
      "complete"
    );
    expect((settled as { value?: string }).value).toBe("hi");
    await orch.stop();
  });

  test("persisted runs.step is the registered name, not workflow.name", async () => {
    const orch = new Orchestrator({
      config: makeOrchestratorConfig(),
      store,
    });
    await orch.setup();
    orch.register<void, string>("registered-key", () =>
      Workflow.create<void, string>({
        execute: async () => "ok",
        input: undefined,
        name: "internal-name",
      })
    );
    await orch.start();
    const id = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const d = yield* Effect.promise(() =>
            orch.run<void, string>("registered-key", undefined)
          );
          yield* Effect.promise(() => d.result());
          return d.id;
        })
      )
    );
    await orch.drain();
    const row = requireRun(await store.getRun(id));
    expect(row.step).toBe("registered-key");
    await orch.stop();
  });

  test("dispatched.step getter reflects the registered name", async () => {
    const orch = new Orchestrator({
      config: makeOrchestratorConfig(),
      store,
    });
    await orch.setup();
    orch.register<void, string>("step-getter", () =>
      Workflow.create<void, string>({
        execute: async () => "ok",
        input: undefined,
        name: "different-internal",
      })
    );
    await orch.start();
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const d = yield* Effect.promise(() =>
            orch.run<void, string>("step-getter", undefined)
          );
          const stepName = d.step;
          yield* Effect.promise(() => d.result());
          return stepName;
        })
      )
    );
    expect(observed).toBe("step-getter");
    await orch.stop();
  });

  test("throws if name is not registered", async () => {
    const orch = new Orchestrator({
      config: makeOrchestratorConfig(),
      store,
    });
    await orch.setup();
    await orch.start();
    let captured: unknown = null;
    // orch.run synchronously throws via registry.resolve — plain try/await
    // captures cleanly without bridging through Effect.gen.
    try {
      await orch.run("nope", undefined);
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(DefinitionNotRegisteredError);
    expect((captured as Error).message).toMatch(/not registered/i);
    await orch.stop();
  });

  test("Step factory is auto-wrapped into a Workflow on dispatch", async () => {
    const orch = new Orchestrator({
      config: makeOrchestratorConfig(),
      store,
    });
    await orch.setup();
    orch.register<void, number>("step-only", () =>
      Step.from("step-only", async () => 42)
    );
    await orch.start();
    const settled = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const d = yield* Effect.promise(() =>
            orch.run<void, number>("step-only", undefined)
          );
          return yield* Effect.promise(() => d.result());
        })
      )
    );
    expect((settled as { status: string; value?: number }).status).toBe(
      "complete"
    );
    expect((settled as { value?: number }).value).toBe(42);
    await orch.stop();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C. Lifecycle passthroughs
// ════════════════════════════════════════════════════════════════════════════

describe("Orchestrator — lifecycle passthroughs", () => {
  test("setup() and start() are idempotent", async () => {
    const localStore = makeInMemoryStore();
    const orch = new Orchestrator({
      config: makeOrchestratorConfig(),
      store: localStore,
    });
    await Promise.all([orch.setup(), orch.setup()]);
    await Promise.all([orch.start(), orch.start()]);
    await orch.start();
    await expect(localStore.listQueues()).resolves.toHaveLength(1);
    await orch.stop();
  });

  test("setup() shares one failing attempt and retries transient persistence failures", async () => {
    const localStore = makeInMemoryStore();
    const ensureQueue = localStore.ensureQueue.bind(localStore);
    let attempts = 0;
    localStore.ensureQueue = async (input) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("transient queue persistence failure");
      }
      return ensureQueue(input);
    };
    const orch = new Orchestrator({
      config: makeOrchestratorConfig(),
      store: localStore,
    });

    const first = orch.setup();
    const concurrent = orch.setup();
    expect(first).toBe(concurrent);
    await expect(first).rejects.toThrow(/transient queue persistence failure/i);
    await expect(concurrent).rejects.toThrow(
      /transient queue persistence failure/i
    );
    expect(attempts).toBe(1);

    await orch.setup();
    await orch.start();
    expect(attempts).toBeGreaterThan(1);
    await orch.stop();
  });

  test("run() before successful start throws the typed lifecycle error", async () => {
    const orch = new Orchestrator({
      config: makeOrchestratorConfig(),
      store: makeInMemoryStore(),
    });
    await orch.setup();
    orch.register("not-started", () =>
      Workflow.create({
        execute: async () => null,
        input: null,
        name: "not-started",
      })
    );

    expect(() => orch.run("not-started", null)).toThrow(
      OrchestratorNotStartedError
    );
    await orch.stop();
  });

  test("stop() is terminal and idempotent before or during setup", async () => {
    const stoppedBeforeSetup = new Orchestrator({
      config: makeOrchestratorConfig(),
      store: makeInMemoryStore(),
    });
    await Promise.all([stoppedBeforeSetup.stop(), stoppedBeforeSetup.stop()]);
    await expect(stoppedBeforeSetup.setup()).rejects.toThrow(/shut down/i);

    const localStore = makeInMemoryStore();
    const originalListQueues = localStore.listQueues.bind(localStore);
    let releaseSetup: () => void = () => undefined;
    const setupGate = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    localStore.listQueues = async () => {
      await setupGate;
      return originalListQueues();
    };
    const stoppedDuringSetup = new Orchestrator({
      config: makeOrchestratorConfig(),
      store: localStore,
    });
    const setup = stoppedDuringSetup.setup();
    const stop = stoppedDuringSetup.stop();
    releaseSetup();
    await Promise.all([setup, stop]);
    await expect(stoppedDuringSetup.start()).rejects.toThrow(/shut down/i);
    await stoppedDuringSetup.stop();
  });

  test("stop() makes subsequent run() reject (queue is shut down)", async () => {
    const orch = new Orchestrator({
      config: makeOrchestratorConfig(),
      store,
    });
    await orch.setup();
    orch.register<void, string>("after-stop", () =>
      Workflow.create<void, string>({
        execute: async () => "x",
        input: undefined,
        name: "after-stop",
      })
    );
    await orch.start();
    await orch.stop();
    let captured: unknown = null;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.promise(() => orch.run("after-stop", undefined));
          })
        )
      );
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(String(captured)).toMatch(/shut down/i);
  });

  test("pause prevents the next run from starting until resume", async () => {
    const orch = new Orchestrator({
      config: makeOrchestratorConfig(),
      store,
    });
    await orch.setup();
    let started = false;
    orch.register<void, string>("paused-run", () =>
      Workflow.create<void, string>({
        execute: async () => {
          started = true;
          return "ok";
        },
        input: undefined,
        name: "paused-run",
      })
    );
    await orch.start();
    await orch.pause();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const d = yield* Effect.promise(() =>
            orch.run<void, string>("paused-run", undefined)
          );
          // While paused the run should not start.
          yield* Effect.sleep(40);
          expect(started).toBe(false);
          yield* Effect.promise(() => orch.resume());
          yield* Effect.promise(() => d.result());
        })
      )
    );
    expect(started).toBe(true);
    await orch.stop();
  });

  test("drain resolves only after in-flight runs complete", async () => {
    const orch = new Orchestrator({
      config: makeOrchestratorConfig(),
      store,
    });
    await orch.setup();
    orch.register<void, string>("slow-drain", () =>
      Workflow.create<void, string>({
        execute: async () => {
          await new Promise<void>((r) => setTimeout(r, 50));
          return "done";
        },
        input: undefined,
        name: "slow-drain",
      })
    );
    await orch.start();
    let dispatchedAt = 0;
    let drainResolvedAt = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            orch.run<void, string>("slow-drain", undefined)
          );
          dispatchedAt = Date.now();
          yield* Effect.sleep(10);
          yield* Effect.promise(() => orch.drain());
          drainResolvedAt = Date.now();
        })
      )
    );
    expect(drainResolvedAt - dispatchedAt).toBeGreaterThanOrEqual(45);
    await orch.stop();
  });

  test("get(runId) returns the dispatched handle", async () => {
    const orch = new Orchestrator({
      config: makeOrchestratorConfig(),
      store,
    });
    await orch.setup();
    orch.register<void, string>("getter", () =>
      Workflow.create<void, string>({
        execute: async () => "ok",
        input: undefined,
        name: "getter",
      })
    );
    await orch.start();
    const { dispatchedId, fetched } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const d = yield* Effect.promise(() =>
            orch.run<void, string>("getter", undefined)
          );
          const got = yield* Effect.promise(() => orch.get(d.id));
          yield* Effect.promise(() => d.result());
          return { dispatchedId: d.id, fetched: got };
        })
      )
    );
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(dispatchedId);
    await orch.stop();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// D. Startup-owned recovery
// ════════════════════════════════════════════════════════════════════════════

describe("Orchestrator.start — cold-start hydration", () => {
  test("start recovers each non-terminal Run exactly once", async () => {
    const localStore = makeInMemoryStore();
    const orch = new Orchestrator({
      config: makeOrchestratorConfig(),
      store: localStore,
    });
    await orch.setup();
    const [queue] = await localStore.listQueues();
    if (!queue) {
      throw new Error("expected queue");
    }
    const runId = "rn-recover-once";
    await localStore.createRun({
      definition: { name: "recover-once" },
      id: runId,
      input: null,
      queueId: queue.id,
      step: "recover-once",
    });
    let calls = 0;
    orch.register("recover-once", () =>
      Workflow.create({
        execute: async () => {
          calls++;
          return "ok";
        },
        input: null,
        name: "recover-once",
      })
    );

    await Promise.all([orch.start(), orch.start()]);
    const recovered = await orch.get(runId);
    if (!recovered) {
      throw new Error("expected recovered handle");
    }
    await recovered.result();
    await orch.start();
    expect(calls).toBe(1);
    await orch.stop();
  });

  test("missing definitions fail startup before any Run is adopted and permit retry", async () => {
    const localStore = makeInMemoryStore();
    const orch = new Orchestrator({
      config: makeOrchestratorConfig(),
      store: localStore,
    });
    await orch.setup();
    const [queue] = await localStore.listQueues();
    if (!queue) {
      throw new Error("expected queue");
    }
    await localStore.createRun({
      definition: { name: "known-recovery" },
      id: "rn-known-recovery",
      input: null,
      queueId: queue.id,
      step: "known-recovery",
    });
    await localStore.createRun({
      definition: { name: "missing-recovery" },
      id: "rn-missing-recovery",
      input: null,
      queueId: queue.id,
      step: "missing-recovery",
    });
    let knownCalls = 0;
    orch.register("known-recovery", () =>
      Workflow.create({
        execute: async () => {
          knownCalls++;
          return "known";
        },
        input: null,
        name: "known-recovery",
      })
    );

    await expect(orch.start()).rejects.toBeInstanceOf(
      RecoverableDefinitionMissingError
    );
    expect(() => orch.run("known-recovery", null)).toThrow(
      OrchestratorNotStartedError
    );
    expect(knownCalls).toBe(0);
    await expect(localStore.getRun("rn-known-recovery")).resolves.toMatchObject(
      { status: "queued" }
    );

    orch.register("missing-recovery", () =>
      Workflow.create({
        execute: async () => "missing-now-known",
        input: null,
        name: "missing-recovery",
      })
    );
    await orch.start();
    const known = await orch.get("rn-known-recovery");
    const formerlyMissing = await orch.get("rn-missing-recovery");
    if (!(known && formerlyMissing)) {
      throw new Error("expected recovered Runs");
    }
    await Promise.all([known.result(), formerlyMissing.result()]);
    expect(knownCalls).toBe(1);
    await orch.stop();
  });

  test("a factory construction failure adopts no earlier prepared Run", async () => {
    const localStore = makeInMemoryStore();
    const orch = new Orchestrator({
      config: makeOrchestratorConfig(),
      store: localStore,
    });
    await orch.setup();
    const [queue] = await localStore.listQueues();
    if (!queue) {
      throw new Error("expected queue");
    }
    await localStore.createRun({
      definition: { name: "prepared-first" },
      id: "rn-prepared-first",
      input: null,
      queueId: queue.id,
      step: "prepared-first",
    });
    await localStore.createRun({
      definition: { name: "build-fails" },
      id: "rn-build-fails",
      input: null,
      queueId: queue.id,
      step: "build-fails",
    });
    let firstCalls = 0;
    orch.register("prepared-first", () =>
      Workflow.create({
        execute: async () => {
          firstCalls++;
          return "first";
        },
        input: null,
        name: "prepared-first",
      })
    );
    orch.register("build-fails", () => {
      throw new Error("factory construction failed");
    });

    await expect(orch.start()).rejects.toThrow(/construction failed/i);
    expect(firstCalls).toBe(0);
    expect(await orch.get("rn-prepared-first")).toBeNull();
    await expect(localStore.getRun("rn-prepared-first")).resolves.toMatchObject(
      { status: "queued" }
    );
    expect(() => orch.run("prepared-first", null)).toThrow(
      OrchestratorNotStartedError
    );
    await orch.stop();
  });

  test("stop does not wait for a blocked recovery factory or permit late adoption", async () => {
    const localStore = makeInMemoryStore();
    const orch = new Orchestrator({
      config: makeOrchestratorConfig(),
      store: localStore,
    });
    await orch.setup();
    const [queue] = await localStore.listQueues();
    if (!queue) {
      throw new Error("expected queue");
    }
    const runId = "rn-blocked-recovery";
    await localStore.createRun({
      definition: { name: "blocked-recovery" },
      id: runId,
      input: null,
      queueId: queue.id,
      step: "blocked-recovery",
    });
    let releaseFactory: () => void = () => undefined;
    let announceFactory: () => void = () => undefined;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    const factoryEntered = new Promise<void>((resolve) => {
      announceFactory = resolve;
    });
    orch.register("blocked-recovery", async () => {
      announceFactory();
      await factoryGate;
      return Workflow.create({
        execute: async () => "too-late",
        input: null,
        name: "blocked-recovery",
      });
    });

    const starting = orch.start();
    await factoryEntered;
    const stopOutcome = await Promise.race([
      orch.stop({ graceMs: 1 }).then(() => "stopped" as const),
      new Promise<"timed-out">((resolve) => {
        setTimeout(() => {
          resolve("timed-out");
        }, 100);
      }),
    ]);
    expect(stopOutcome).toBe("stopped");
    releaseFactory();
    await expect(starting).rejects.toThrow(/shut down/i);
    expect(await orch.get(runId)).toBeNull();
    await expect(localStore.getRun(runId)).resolves.toMatchObject({
      status: "queued",
    });
  });

  test("recover() cannot run independently once the runtime is live", async () => {
    const orch = new Orchestrator({
      config: makeOrchestratorConfig(),
      store: makeInMemoryStore(),
    });
    await orch.setup();
    await orch.start();
    await expect(orch.recover()).rejects.toThrow(/owned by.*start/i);
    await orch.stop();
  });

  test("startup skips a completed persisted root snapshot", async () => {
    const localStore = makeInMemoryStore();
    const orch = new Orchestrator({
      config: makeOrchestratorConfig(),
      store: localStore,
    });
    await orch.setup();
    const [queue] = await localStore.listQueues();
    if (!queue) {
      throw new Error("expected queue");
    }
    const at = new Date().toISOString();
    const runId = "rn-skip-root";
    await localStore.createRun({
      definition: { name: "skip-root" },
      id: runId,
      input: null,
      metadata: {
        workflow: {
          input: null,
          steps: {
            "skip-root": {
              attempt: 1,
              completedAt: at,
              durationMs: 1,
              name: "skip-root",
              namespace: "",
              output: "persisted-output",
              startedAt: at,
              status: "complete",
            },
          },
        },
      },
      queueId: queue.id,
      step: "skip-root",
    });
    let calls = 0;
    orch.register("skip-root", () =>
      Workflow.create({
        execute: async () => {
          calls++;
          return "fresh-output";
        },
        input: null,
        name: "skip-root",
      })
    );

    await orch.start();
    const recovered = await orch.get(runId);
    if (!recovered) {
      throw new Error("expected recovered Run");
    }
    await recovered.result();
    expect(calls).toBe(0);
    await orch.stop();
  });

  test("startup preserves per-child skip-on-complete paths", async () => {
    const localStore = makeInMemoryStore();
    const orch = new Orchestrator({
      config: makeOrchestratorConfig(),
      store: localStore,
    });
    await orch.setup();
    const [queue] = await localStore.listQueues();
    if (!queue) {
      throw new Error("expected queue");
    }
    const at = new Date().toISOString();
    const runId = "rn-skip-child";
    await localStore.createRun({
      definition: { name: "parent-with-kids" },
      id: runId,
      input: null,
      metadata: {
        workflow: {
          input: null,
          steps: {
            "parent-with-kids.child-a": {
              attempt: 1,
              completedAt: at,
              durationMs: 1,
              name: "child-a",
              namespace: "parent-with-kids",
              output: "a-cached",
              startedAt: at,
              status: "complete",
            },
          },
        },
      },
      queueId: queue.id,
      step: "parent-with-kids",
    });
    let childACalls = 0;
    let childBCalls = 0;
    orch.register("parent-with-kids", () =>
      Step.make<null, string>({
        children: [
          {
            execute: async () => {
              childACalls++;
              return "a-fresh";
            },
            input: null,
            name: "child-a",
          },
          {
            execute: async () => {
              childBCalls++;
              return "b-fresh";
            },
            input: null,
            name: "child-b",
          },
        ],
        execute: async (_input, ctx) => {
          const [childA, childB] = ctx.children;
          if (!(childA && childB)) {
            throw new Error("expected two children");
          }
          const a = (await childA.run()) as string;
          const b = (await childB.run()) as string;
          return `${a}+${b}`;
        },
        input: null,
        name: "parent-with-kids",
      })
    );

    await orch.start();
    const recovered = await orch.get(runId);
    if (!recovered) {
      throw new Error("expected recovered Run");
    }
    await recovered.result();
    expect(childACalls).toBe(0);
    expect(childBCalls).toBe(1);
    await orch.stop();
  });

  test("startup ignores terminal Run rows", async () => {
    const localStore = makeInMemoryStore();
    const orch = new Orchestrator({
      config: makeOrchestratorConfig(),
      store: localStore,
    });
    await orch.setup();
    const [queue] = await localStore.listQueues();
    if (!queue) {
      throw new Error("expected queue");
    }
    const run = await localStore.createRun({
      definition: { name: "terminal" },
      id: "rn-terminal",
      input: null,
      queueId: queue.id,
      step: "terminal",
    });
    await localStore.updateRun(run.id, { status: "complete" });
    let calls = 0;
    orch.register("terminal", () =>
      Workflow.create({
        execute: async () => {
          calls++;
          return "unexpected";
        },
        input: null,
        name: "terminal",
      })
    );

    await orch.start();
    expect(await orch.get(run.id)).toBeNull();
    expect(calls).toBe(0);
    await orch.stop();
  });
});
