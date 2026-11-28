import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { thisProcess } from "@foundry/lib/node/process-identity";
import type {
  CollectInput,
  Enqueued,
  EnqueueOptions,
  RunView,
} from "@foundry.sh/marbles";
import { observe, runs, step, tasks, workflow } from "@foundry.sh/marbles";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import { z } from "zod";
import { Catalog } from "~/authoring/catalog";
import {
  captureScope,
  releaseEngine,
  setHost,
  withLoadScope,
} from "~/authoring/runtime";
import { DatabaseRunStore } from "~/database/runs";
import { DEFINITION_IDENTITY } from "~/lib/definitions/handles";
import type { Engine } from "~/lib/engine";
import { inContext } from "~/lib/runs/context";
import type { RunEvent } from "~/lib/runs/records";
import { startEngine, testEngine } from "./helpers/engine";
import { openFeed } from "./helpers/feed";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";

const RUN_ID = /^rn-/;
const LOAD_FIRST = /^load:definition#0:[0-9a-f]{16}$/;
const LOAD_SECOND = /^load:definition#1:[0-9a-f]{16}$/;
const CLOSURE_IDENTITY = /^closure:definition#\d+:[0-9a-f]{16}$/;
const SCHEMA = /"typed-leaf" input/;
const RELEASED = /no longer hosted in this process/;
const DISPOSED_RUNS = /host that held these runs was disposed/;
const RETIRING = /this engine is retiring/;
const STOPPING = /engine is stopping/;

const engines: Engine[] = [];
let machine: TestMachine;

beforeAll(async () => {
  machine = await testMachine();
});

afterAll(() => {
  machine.close();
});

afterEach(async () => {
  const disposed = engines.splice(0);
  await Promise.all(disposed.map((engine) => engine.dispose()));
  for (const engine of disposed) {
    releaseEngine(engine);
  }
});

function host(
  options: boolean | { askable?: boolean; collect?: CollectInput } = false
): Engine {
  const opts = typeof options === "boolean" ? { askable: options } : options;
  const state = machine.workspace();
  const records = machine.records(state);
  const engine = testEngine({
    askable: opts.askable ?? false,
    ...(opts.collect === undefined ? {} : { collect: opts.collect }),
    print: () => undefined,
    records,
    runs: new DatabaseRunStore({
      changes: records.changes,
      database: machine.database.database,
      scope: basename(state),
    }),
    state,
  });
  engines.push(engine);
  setHost(engine);
  return engine;
}

function unhosted(
  options: boolean | { askable?: boolean; collect?: CollectInput } = false
): Engine {
  const opts = typeof options === "boolean" ? { askable: options } : options;
  const engine = testEngine({
    askable: opts.askable ?? false,
    ...(opts.collect === undefined ? {} : { collect: opts.collect }),
    print: () => undefined,
  });
  engines.push(engine);
  return engine;
}

async function answerOpen(engine: Engine): Promise<void> {
  const question = await vi.waitFor(async () => {
    const open = (await engine.feed()).find(
      (entry) => entry.input?.status === "open"
    );
    expect(open).toBeDefined();
    return open;
  });
  await engine.answer(question?.id ?? "", "yes");
}

describe(".enqueue()", () => {
  it("is typed by the package's own Enqueued and EnqueueOptions, on a definition and on step and workflow by name", () => {
    const leaf = step("typed-enqueue").do(() => "leaf");
    expectTypeOf(leaf.enqueue).returns.toEqualTypeOf<
      Promise<Enqueued<string>>
    >();
    expectTypeOf(leaf.enqueue)
      .parameter(1)
      .toEqualTypeOf<EnqueueOptions | undefined>();
    expectTypeOf(step.enqueue<number>)
      .parameter(2)
      .toEqualTypeOf<EnqueueOptions | undefined>();
    expectTypeOf(workflow.enqueue<number>).returns.toEqualTypeOf<
      Promise<Enqueued<number>>
    >();
    expectTypeOf<EnqueueOptions>().toEqualTypeOf<{
      readonly key?: string;
    }>();
    expect(Reflect.has(leaf, "launch")).toBe(false);
    expect(Reflect.has(step, "launch")).toBe(false);
    expect(Reflect.has(workflow, "launch")).toBe(false);
  });

  it("admits a run from an observer and hands back its id at once, so the observer keeps its place while the run waits on a question", async () => {
    const review = step("held-review")
      .input(z.object({ title: z.string() }))
      .do(async ({ ask, input }) => {
        const answer = await ask.question({ title: `Ship ${input.title}?` });
        return `${input.title}: ${String(answer)}`;
      });
    const handed: string[] = [];
    const dispatcher = observe(
      tasks,
      async (event) => {
        for (const delta of event.tasks) {
          if (delta.before !== null || delta.after === null) {
            continue;
          }
          const { id } = await review.enqueue({ title: delta.after.title });
          await tasks.update(delta.after.id, { metadata: { run: id } });
          handed.push(delta.after.title);
        }
      },
      { name: "dispatcher" }
    );
    const engine = host({ askable: true, collect: [review, dispatcher] });
    await engine.start();

    const first = await tasks.create({ title: "first" });
    const firstRun = await vi.waitFor(async () => {
      const run = (await tasks.get(first.id))?.metadata?.run;
      expect(run).toBeTypeOf("string");
      return run as string;
    });
    await vi.waitFor(async () =>
      expect((await runs.get(firstRun))?.status).toBe("suspended")
    );

    const second = await tasks.create({ title: "second" });
    await vi.waitFor(() => expect(handed).toEqual(["first", "second"]));
    expect((await runs.get(firstRun))?.status).toBe("suspended");
    const secondRun = (await tasks.get(second.id))?.metadata?.run as string;
    expect(secondRun).not.toBe(firstRun);

    await answerOpen(engine);
    await answerOpen(engine);
    await vi.waitFor(async () => {
      const done = await runs.list({
        name: "held-review",
        status: "complete",
      });
      expect(done.map((run) => run.id).sort()).toEqual(
        [firstRun, secondRun].sort()
      );
    });
    expect((await runs.get(firstRun))?.output).toBe("first: yes");
  });

  it("launches named and anonymous definitions, steps and workflows alike, resolving before they end", async () => {
    const release = Promise.withResolvers<void>();
    const held = step("held-leaf").do(async () => {
      await release.promise;
      return "held";
    });
    const anonymous = workflow(() => held());
    const engine = host();
    await engine.start();

    const named = await held.enqueue();
    const unnamed = await anonymous.enqueue();
    expect(named.id).toMatch(RUN_ID);
    expect(unnamed.id).toMatch(RUN_ID);
    expect(engine.executions.get(named.id)?.status).toBe("running");
    expect((await runs.get(named.id))?.name).toBe("held-leaf");
    release.resolve();
    await expect(named.result).resolves.toBe("held");
    await expect(unnamed.result).resolves.toBe("held");
    expect((await runs.get(unnamed.id))?.status).toBe("complete");
  });

  it("leaves no unhandled rejection when nobody awaits a failed run's result", async () => {
    const failing = step("failing-leaf").do(() => {
      throw new Error("broke");
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const engine = host();
      await engine.start();
      const { id } = await failing.enqueue();
      await vi.waitFor(async () =>
        expect((await runs.get(id))?.status).toBe("failed")
      );
      expect((await runs.get(id))?.error).toContain("broke");
      await new Promise((done) => setTimeout(done, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("refuses once the engine retires or is disposed", async () => {
    const leaf = step("refused-leaf").do(() => "never");
    const engine = host();
    await engine.start();
    await engine.retire({ pid: thisProcess().pid + 1, started: null });
    await expect(leaf.enqueue()).rejects.toThrow(RETIRING);
    await engine.dispose();
    await expect(engine.enqueueDefinition(leaf, {})).rejects.toThrow(STOPPING);
  });

  it("from a step body launches a top-level run of that step's own engine, once per call however often the body runs again", async () => {
    let bodies = 0;
    const child = step("launched-child").do(() => "child");
    const parent = step("launching-parent").do(async ({ ask }) => {
      bodies += 1;
      const launched = await child.enqueue();
      await ask.question({ title: "Continue?" });
      return { child: launched.id, value: await launched.result };
    });
    const engine = unhosted({ askable: true, collect: [child, parent] });
    await engine.start();
    const running = engine.execute<{ child: string; value: string }>(
      parent,
      {}
    );
    await answerOpen(engine);
    const outcome = await running;

    expect(outcome.value).toBe("child");
    expect(bodies).toBe(2);
    expect(engine.executions.get(outcome.child)?.name).toBe("launched-child");
    expect(
      engine.executions.list().filter((run) => run.name === "launched-child")
    ).toHaveLength(1);
    const view = await engine.readRun(outcome.child);
    expect(view).toMatchObject({
      kind: "workflow",
      name: "launched-child",
      output: "child",
      status: "complete",
    });
  });
});

describe("runs", () => {
  it("reads the run an observer of workflow is told of, by its id", async () => {
    const seen: (RunView | null)[] = [];
    const greet = step("greet-run").do(() => "hello");
    const completions = observe(
      workflow,
      async (fact: RunEvent) => {
        seen.push(await runs.get(fact.runId));
      },
      { name: "completions", types: ["run.completed"] }
    );
    const engine = host({ collect: { completions, greet } });
    await engine.start();
    const { id } = await greet.enqueue();

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({
      id,
      name: "greet-run",
      output: "hello",
      status: "complete",
    });
    expect(seen[0]?.queuedAt).toBeTypeOf("string");
    expect(seen[0]?.endedAt).toBeTypeOf("string");
  });

  it("reads inside a step, answers null for an unknown id, and filters a listing", async () => {
    const first = step("listed-a").do(() => 1);
    const second = step("listed-b").do(() => 2);
    const reader = step("reader").do(async ({ run }) => ({
      self: (await runs.get(run.id))?.status,
      unknown: await runs.get("rn-missing"),
    }));
    const engine = host();
    await engine.start();
    await first.run();
    await second.run();

    await expect(reader.run()).resolves.toEqual({
      self: "running",
      unknown: null,
    });
    expect(
      (await runs.list({ name: "listed-a" })).map((run) => run.name)
    ).toEqual(["listed-a"]);
    expect(
      (await runs.list({ status: ["complete"] })).map((run) => run.name)
    ).toEqual(expect.arrayContaining(["listed-a", "listed-b", "reader"]));
    await expect(runs.get("")).rejects.toThrow(TypeError);
  });

  it("refuses once its host is disposed, like tasks", async () => {
    const engine = host();
    await engine.start();
    await engine.dispose();
    await expect(runs.get("rn-1")).rejects.toThrow(DISPOSED_RUNS);
    await expect(runs.list()).rejects.toThrow(DISPOSED_RUNS);
  });
});

describe(".enqueue() at its edges", () => {
  it("launches again when a body that runs again reaches another definition at the same place", async () => {
    let bodies = 0;
    const first = step("first-choice").do(() => "first");
    const second = step("second-choice").do(() => "second");
    const chooser = step("chooser").do(async ({ ask }) => {
      bodies += 1;
      const launched = await (bodies === 1 ? first : second).enqueue();
      await ask.question({ title: "Again?" });
      return launched.id;
    });
    const engine = unhosted({
      askable: true,
      collect: [first, second, chooser],
    });
    await engine.start();
    const running = engine.execute<string>(chooser, {});
    await answerOpen(engine);
    const id = await running;

    expect(bodies).toBe(2);
    expect(engine.executions.get(id)?.name).toBe("second-choice");
    expect(
      engine.executions
        .list()
        .map((run) => run.name)
        .filter((name) => name.endsWith("-choice"))
    ).toEqual(["first-choice", "second-choice"]);
  });

  it("distinguishes distinct anonymous definitions at the same replay place", async () => {
    const first = step().do(() => "first");
    const second = step().do(() => "second");
    let bodies = 0;
    const chooser = step("closure-chooser").do(async ({ ask }) => {
      bodies += 1;
      const launched = await (bodies === 1 ? first : second).enqueue();
      await ask.question({ title: "Again?" });
      return launched.id;
    });
    const engine = unhosted({
      askable: true,
      collect: [first, second, chooser],
    });
    await engine.start();
    const running = engine.execute<string>(chooser, {});
    await answerOpen(engine);
    const id = await running;
    await vi.waitFor(async () =>
      expect((await engine.readRun(id))?.status).toBe("complete")
    );
    expect((await engine.readRun(id))?.output).toBe("second");
  });

  it("distinguishes unnamed inline definitions on replay and reuses the same unnamed definition", async () => {
    let switchBodies = 0;
    const switcher = step("unnamed-switcher").do(async ({ ask }) => {
      switchBodies += 1;
      const launched =
        switchBodies === 1
          ? await step()
              .do(() => "first-anon")
              .enqueue()
          : await step()
              .do(() => "second-anon")
              .enqueue();
      await ask.question({ title: "Switch?" });
      return launched.id;
    });

    let sameBodies = 0;
    let sameRuns = 0;
    const repeater = step("unnamed-repeater").do(async ({ ask }) => {
      sameBodies += 1;
      const launched = await step()
        .do(() => {
          sameRuns += 1;
          return "same-anon";
        })
        .enqueue();
      await ask.question({ title: "Repeat?" });
      return launched.id;
    });

    const engine = unhosted(true);
    await engine.start();

    const switching = engine.execute<string>(switcher, {});
    await answerOpen(engine);
    const switchedId = await switching;
    expect(switchBodies).toBe(2);
    await vi.waitFor(async () =>
      expect((await engine.readRun(switchedId))?.status).toBe("complete")
    );
    expect((await engine.readRun(switchedId))?.output).toBe("second-anon");

    const repeating = engine.execute<string>(repeater, {});
    await answerOpen(engine);
    const repeatedId = await repeating;
    expect(sameBodies).toBe(2);
    await vi.waitFor(async () =>
      expect((await engine.readRun(repeatedId))?.status).toBe("complete")
    );
    expect(sameRuns).toBe(1);
    expect((await engine.readRun(repeatedId))?.output).toBe("same-anon");
  });

  it("rejects a launch whose input its schema refuses before any run exists, whether or not its queue has room", async () => {
    const typed = step("typed-leaf")
      .input(z.object({ count: z.number() }))
      .do(({ input }) => input.count);
    const release = Promise.withResolvers<void>();
    const hold = step("hold-lane").do(() => release.promise);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const engine = host({ collect: [typed, hold] });
      await engine.start();
      const wrong = { count: "many" } as unknown as { count: number };
      await expect(typed.enqueue(wrong)).rejects.toThrow(SCHEMA);

      const held = await hold.enqueue();
      const before = (await runs.list()).length;
      await expect(typed.enqueue(wrong)).rejects.toThrow(SCHEMA);
      expect(await runs.list()).toHaveLength(before);
      release.resolve();
      await held.result;
      await new Promise((done) => setTimeout(done, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("refuses a launch and a read from a captured scope whose host was disposed", async () => {
    const into = new Catalog();
    const engine = testEngine({
      print: () => undefined,
      workspaceId: "launch-released",
    });
    engines.push(engine);
    setHost(engine, into);
    await engine.start();
    const scope = inContext(engine.context, captureScope);
    const leaf = step("released-leaf").do(() => "never");
    await engine.dispose();
    releaseEngine(engine);

    await expect(scope(() => leaf.enqueue())).rejects.toThrow(RELEASED);
    await expect(scope(() => runs.get("rn-1"))).rejects.toThrow(RELEASED);
  });
});

interface Enqueueable {
  enqueue(): Promise<{
    readonly id: string;
    readonly result: Promise<unknown>;
  }>;
}

function identityOf(definition: object): string | undefined {
  return (definition as { [DEFINITION_IDENTITY]?: string })[
    DEFINITION_IDENTITY
  ];
}

function isolated(workspaceId: string): Engine {
  const engine = testEngine({
    askable: true,
    print: () => undefined,
    workspaceId,
  });
  engines.push(engine);
  return engine;
}

async function replayedEnqueue(
  name: string,
  pick: (body: number) => Enqueueable
): Promise<{ readonly bodies: number; readonly output: unknown }> {
  let bodies = 0;
  const chooser = step(name).do(async ({ ask }) => {
    bodies += 1;
    const launched = await pick(bodies).enqueue();
    await ask.question({ title: "Again?" });
    return launched.id;
  });
  const engine = isolated(name);
  await engine.start();
  const running = engine.execute<string>(chooser, {});
  await answerOpen(engine);
  const id = await running;
  await vi.waitFor(async () =>
    expect((await engine.readRun(id))?.status).toBe("complete")
  );
  return { bodies, output: (await engine.readRun(id))?.output };
}

describe("an unnamed .enqueue() on replay", () => {
  it("tells apart distinct anonymous definitions from one factory and reuses the same one", async () => {
    const calls: string[] = [];
    const make = (value: string) =>
      step().do(() => {
        calls.push(value);
        return value;
      });
    const built = ["a", "b", "c"].map(make);
    expect(new Set(built.map(identityOf)).size).toBe(3);
    const [firstBuilt] = built;
    expect(firstBuilt && identityOf(firstBuilt)).toMatch(CLOSURE_IDENTITY);
    await expect(
      replayedEnqueue(
        "loop-switch",
        (body) => built[body === 1 ? 0 : 2] as Enqueueable
      )
    ).resolves.toEqual({ bodies: 2, output: "c" });
    await expect(
      replayedEnqueue("loop-same", () => built[1] as Enqueueable)
    ).resolves.toEqual({ bodies: 2, output: "b" });
    expect(calls).toEqual(["a", "c", "b"]);
  });

  it("tells apart each .do() of one reused builder", async () => {
    const base = step().describe("shared builder");
    const first = base.do(() => "first-do");
    const second = base.do(() => "second-do");
    expect(identityOf(first)).not.toBe(identityOf(second));
    await expect(
      replayedEnqueue("builder-switch", (body) => (body === 1 ? first : second))
    ).resolves.toEqual({ bodies: 2, output: "second-do" });
  });

  it("tells apart definitions on one line and those an exec wrapper builds", async () => {
    const pair = [step().do(() => 1), step().do(() => 2)] as const;
    const sh = (command: string) => step().exec(command);
    const wrapped = [sh("true"), sh("false")];
    expect(new Set([...pair, ...wrapped].map(identityOf)).size).toBe(4);
    await expect(
      replayedEnqueue("line-switch", (body) => pair[body === 1 ? 0 : 1])
    ).resolves.toEqual({ bodies: 2, output: 2 });
  });

  it("tells apart definitions a body builds one at a time on one line", async () => {
    const pick = (body: number) =>
      body === 1 ? step().do(() => 1) : step().do(() => 2);
    await expect(replayedEnqueue("column-switch", pick)).resolves.toEqual({
      bodies: 2,
      output: 2,
    });
  });

  it("treats one place reached with other captured values as the same definition", async () => {
    const make = (value: string) => step().do(() => value);
    await expect(
      replayedEnqueue("captured-values", (body) =>
        make(body === 1 ? "kept" : "changed")
      )
    ).resolves.toEqual({ bodies: 2, output: "kept" });
  });

  it("numbers a body's definitions apart from a nested workflow's setup that replay skips", async () => {
    let launches = 0;
    function make(value: string) {
      return step().do(() => {
        launches += 1;
        return value;
      });
    }
    const leaf = step("setup-leaf").do(() => "leaf");
    const child = workflow().do(() => {
      make("in-setup");
      return leaf();
    });
    let bodies = 0;
    const parent = step("setup-then-launch").do(async ({ ask }) => {
      bodies += 1;
      await child.run();
      const launched = await make("after-setup").enqueue();
      await ask.question({ title: "Again?" });
      return launched.id;
    });
    const engine = isolated("setup-then-launch");
    await engine.start();
    const running = engine.execute<string>(parent, {});
    await answerOpen(engine);
    const id = await running;
    await vi.waitFor(async () =>
      expect((await engine.readRun(id))?.status).toBe("complete")
    );
    expect(bodies).toBe(2);
    expect(launches).toBe(1);
    expect((await engine.readRun(id))?.output).toBe("after-setup");
  });

  it("claims a setup's definitions in setup and a body's in that body, either way they nest", async () => {
    const seen: string[] = [];
    const record = (definition: object) =>
      seen.push((identityOf(definition) ?? "").split(":")[0] ?? "");
    const probe = step("nested-probe").do(() => {
      record(step().do(() => "probe"));
      return "probed";
    });
    const child = workflow().do(async () => {
      record(step().do(() => "setup"));
      await probe.run();
      return probe();
    });
    const outer = step("nesting-outer").do(async () => {
      record(step().do(() => "outer"));
      return await child.run();
    });
    const engine = isolated("nesting-outer");
    await engine.start();
    await expect(engine.execute(outer, {})).resolves.toBe("probed");
    expect(seen).toEqual(["run", "setup", "run", "run"]);
  });

  it("claims a locked nested workflow's setup definitions in setup", async () => {
    const seen: string[] = [];
    const leaf = step("locked-leaf").do(() => "leaf");
    const inner = workflow("locked-inner").do(() => {
      seen.push((identityOf(step().do(() => "x")) ?? "").split(":")[0] ?? "");
      return leaf();
    });
    const outer = workflow("locked-outer", () => inner());
    const engine = isolated("locked-outer");
    await engine.start();
    await expect(engine.execute(outer, {})).resolves.toBe("leaf");
    expect(seen).toEqual(["setup"]);
  });

  it("numbers each source load's definitions on its own, however loads interleave", async () => {
    const build = () => step().do(() => "loaded");
    const ids = new Map<string, string[]>();
    const gate = Promise.withResolvers<void>();
    function loadOf(workspaceId: string, between?: Promise<void>) {
      return withLoadScope({ workspaceId }, async () => {
        const own: string[] = [];
        ids.set(workspaceId, own);
        own.push(identityOf(build()) ?? "");
        await between;
        own.push(identityOf(build()) ?? "");
      });
    }
    const first = loadOf("interleave-a", gate.promise);
    await loadOf("interleave-b");
    gate.resolve();
    await first;
    const [one, two] = ids.get("interleave-a") ?? [];
    expect(one).toMatch(LOAD_FIRST);
    expect(two).toMatch(LOAD_SECOND);
    expect(ids.get("interleave-b")).toEqual([one, two]);
  });

  it("restores a completed unnamed enqueue after a restart without running it again", async () => {
    const root = await mkdtemp(join(tmpdir(), "marbles-launch-restart-"));
    try {
      const state = join(root, "state");
      const feedRoot = join(root, "feed");
      let childCalls = 0;
      let parentCalls = 0;
      function declare() {
        return withLoadScope({ workspaceId: "ws" }, () => {
          const make = (value: number) =>
            step().do(() => {
              childCalls += 1;
              return value;
            });
          const built = [make(1), make(2)];
          const parent = step("restart-launcher").do(async ({ ask }) => {
            parentCalls += 1;
            const launched = await (built[1] as Enqueueable).enqueue();
            await ask.approval({ title: "Keep the enqueued result?" });
            return { id: launched.id, value: await launched.result };
          });
          const flow = workflow("restart-launch", () => parent());
          return Promise.resolve({ flow, parent });
        });
      }
      const firstDeclared = await declare();
      const feedOne = openFeed(feedRoot, { id: "ws", root });
      const one = await startEngine({
        artifacts: feedOne.artifacts,
        askable: true,
        collect: firstDeclared,
        print: () => undefined,
        root,
        state,
      });
      engines.push(one);
      const launched = await one.launch("restart-launch", {});
      launched.result.catch(() => undefined);
      const question = await vi.waitFor(async () => {
        const open = (await feedOne.read()).find(
          (entry) => entry.input?.status === "open"
        );
        expect(open).toBeDefined();
        return open;
      });
      const childId = await vi.waitFor(async () => {
        const all = await one.runs();
        expect(all.find((run) => run.id === launched.id)?.status).toBe(
          "suspended"
        );
        const child = all.find((run) => run.id !== launched.id);
        expect(child?.status).toBe("complete");
        return child?.id;
      });
      await one.dispose();
      expect({ childCalls, parentCalls }).toEqual({
        childCalls: 1,
        parentCalls: 1,
      });

      const secondDeclared = await declare();
      const feedTwo = openFeed(feedRoot, { id: "ws", root });
      const two = await startEngine({
        artifacts: feedTwo.artifacts,
        askable: true,
        collect: secondDeclared,
        print: () => undefined,
        root,
        state,
      });
      engines.push(two);
      await two.answer(question?.id ?? "", "approve");
      await vi.waitFor(async () => {
        const run = (await two.runs()).find((each) => each.id === launched.id);
        expect(run?.status).toBe("complete");
        expect(run?.output).toEqual({ id: childId, value: 2 });
      });
      expect({ childCalls, parentCalls }).toEqual({
        childCalls: 1,
        parentCalls: 2,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
