import { basename } from "node:path";
import { thisProcess } from "@foundry/lib/process-identity";
import type { RunEvent } from "@foundry/workflows/schema";
import type { RunView } from "@foundry.sh/marbles";
import { observe, runs, step, tasks, workflow } from "@foundry.sh/marbles";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";
import { catalog } from "~/authoring/catalog";
import { expectHost, setHost } from "~/authoring/runtime";
import { DatabaseRunStore } from "~/database/runs";
import type { Engine } from "~/lib/engine";
import { testEngine } from "./helpers/engine";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";

const RUN_ID = /^rn-/;
const DISPOSED_RUNS = /host that held these runs was disposed/;
const LOADING_RUNS = /runs are not available while its source loads/;
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
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  catalog.reset();
});

function host(askable = false): Engine {
  const state = machine.workspace();
  const records = machine.records(state);
  const engine = testEngine({
    askable,
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

function unhosted(askable = false): Engine {
  const engine = testEngine({ askable, print: () => undefined });
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

describe(".launch()", () => {
  it("admits a run from an observer and hands back its id at once, so the observer keeps its place while the run waits on a question", async () => {
    const review = step("parked-review")
      .input(z.object({ title: z.string() }))
      .do(async ({ ask, input }) => {
        const answer = await ask.question({ title: `Ship ${input.title}?` });
        return `${input.title}: ${String(answer)}`;
      });
    const handed: string[] = [];
    observe(
      tasks,
      async (event) => {
        for (const delta of event.tasks) {
          if (delta.before !== null || delta.after === null) {
            continue;
          }
          const { id } = await review.launch({ title: delta.after.title });
          await tasks.update(delta.after.id, { metadata: { run: id } });
          handed.push(delta.after.title);
        }
      },
      { name: "dispatcher" }
    );
    const engine = host(true);
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
        name: "parked-review",
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

    const named = await held.launch();
    const unnamed = await anonymous.launch();
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
      const { id } = await failing.launch();
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
    await expect(leaf.launch()).rejects.toThrow(RETIRING);
    await engine.dispose();
    await expect(engine.launchDefinition(leaf, {})).rejects.toThrow(STOPPING);
  });

  it("from a step body launches a top-level run of that step's own engine, once per call however often the body runs again", async () => {
    let bodies = 0;
    const child = step("launched-child").do(() => "child");
    const parent = step("launching-parent").do(async ({ ask }) => {
      bodies += 1;
      const launched = await child.launch();
      await ask.question({ title: "Continue?" });
      return { child: launched.id, value: await launched.result };
    });
    const engine = unhosted(true);
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
    observe(
      workflow,
      async (fact: RunEvent) => {
        seen.push(await runs.get(fact.runId));
      },
      { name: "completions", types: ["run.completed"] }
    );
    const engine = host();
    await engine.start();
    const { id } = await greet.launch();

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

  it("refuses while a source loads and once its host is disposed, like tasks", async () => {
    const engine = host();
    await engine.start();
    await engine.dispose();
    await expect(runs.get("rn-1")).rejects.toThrow(DISPOSED_RUNS);
    await expect(runs.list()).rejects.toThrow(DISPOSED_RUNS);
    expectHost();
    await expect(runs.get("rn-1")).rejects.toThrow(LOADING_RUNS);
  });

  it("reads under a dry engine too", async () => {
    const leaf = step("dry-leaf").do(() => "dry");
    const engine = testEngine({ dry: true, print: () => undefined });
    engines.push(engine);
    setHost(engine);
    await engine.start();
    const { id, result } = await leaf.launch();
    await expect(result).resolves.toBe("dry");
    await expect(runs.get(id)).resolves.toMatchObject({ status: "complete" });
  });
});
