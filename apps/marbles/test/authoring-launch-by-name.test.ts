import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { thisProcess } from "@foundry/lib/process-identity";
import { DEFAULT_POOL } from "@foundry/queue";
import {
  monitor,
  observe,
  runs,
  step,
  tasks,
  workflow,
} from "@foundry.sh/marbles";
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
import { libraryOfLoad } from "~/authoring/bound";
import { Catalog, catalog } from "~/authoring/catalog";
import {
  abandonHost,
  loadInto,
  releaseEngine,
  setDefaultRuntime,
  setHost,
} from "~/authoring/runtime";
import { declareCatalog } from "~/create";
import { DatabaseRunStore } from "~/database/runs";
import type { Engine } from "~/lib/engine";
import { testEngine } from "./helpers/engine";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";
import { temporaryDirectory } from "./helpers/temporary";

const BLANK = /give it the name of a (step|workflow) the workspace declares/;
const UNDECLARED = /declares no step or workflow named "missing"/;
const NOT_A_WORKFLOW =
  /"by-name-leaf" is a step, not a workflow; use step\.launch\("by-name-leaf"\)/;
const NOT_A_STEP =
  /"by-name-flow" is a workflow, not a step; use workflow\.launch\("by-name-flow"\)/;
const RETIRING = /this engine is retiring/;
const DISPOSED = /host that held these runs was disposed; nothing was launched/;
const LOADING = /runs are not available while its source loads; launch them/;
const RELEASED = /no longer hosted in this process/;
const AMBIGUOUS = /hosts 2 workspaces/;

const library = await import("~/authoring");

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
  catalog.reset();
});

function host(askable = false): Engine {
  const state = machine.workspace();
  const records = machine.records(state);
  const engine = testEngine({
    askable,
    pools: { [DEFAULT_POOL]: { limit: 4 } },
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

function unhosted(options: { askable?: boolean; limit?: number } = {}): Engine {
  const engine = testEngine({
    askable: options.askable ?? false,
    pools: {
      [DEFAULT_POOL]: { limit: options.limit ?? 4 },
      children: { limit: 1 },
    },
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

describe("step.launch(name) and workflow.launch(name)", () => {
  it("launches the step or workflow the workspace declares by that name, with the input it is given", async () => {
    step("by-name-build")
      .input(z.object({ ref: z.string() }))
      .do(({ input }) => `built ${input.ref}`);
    const leaf = step("by-name-leaf").do(() => "leaf");
    workflow("by-name-flow", () => leaf());
    const engine = host();
    await engine.start();

    const built = await step.launch<string>("by-name-build", { ref: "main" });
    await expect(built.result).resolves.toBe("built main");
    expect((await runs.get(built.id))?.name).toBe("by-name-build");
    const flowed = await workflow.launch("by-name-flow");
    await expect(flowed.result).resolves.toBe("leaf");
    expect((await runs.get(flowed.id))?.name).toBe("by-name-flow");
  });

  it("refuses a blank name, a name the workspace does not declare, a monitor's key, and the other kind", async () => {
    const leaf = step("by-name-leaf").do(() => "leaf");
    workflow("by-name-flow", () => leaf());
    monitor("notes/*.md").do(() => undefined);
    const [watcher] = [...catalog.monitors.keys()];
    const engine = host();
    await engine.start();

    await expect(step.launch("")).rejects.toThrow(BLANK);
    await expect(workflow.launch("   ")).rejects.toThrow(BLANK);
    await expect(
      step.launch(undefined as unknown as string)
    ).rejects.toBeInstanceOf(TypeError);
    await expect(step.launch("missing")).rejects.toThrow(UNDECLARED);
    await expect(workflow.launch("missing")).rejects.toThrow(UNDECLARED);
    expect(watcher).toBeTypeOf("string");
    await expect(step.launch(watcher ?? "")).rejects.toThrow(
      "declares no step or workflow"
    );
    await expect(workflow.launch("by-name-leaf")).rejects.toThrow(
      NOT_A_WORKFLOW
    );
    await expect(step.launch("by-name-flow")).rejects.toThrow(NOT_A_STEP);
    expect(engine.executions.list()).toHaveLength(0);
  });

  it("shares one key with the definition's own launch, whichever comes first", async () => {
    let bodies = 0;
    const build = step("by-name-keyed")
      .input(z.object({ ref: z.string() }))
      .do(({ input }) => {
        bodies += 1;
        return `built ${input.ref}`;
      });
    const leaf = step("by-name-flow-leaf").do(() => {
      bodies += 1;
      return "leaf";
    });
    const flow = workflow("by-name-keyed-flow", () => leaf());
    const engine = host();
    await engine.start();

    const direct = await build.launch({ ref: "a" }, { key: "one" });
    const named = await step.launch(
      "by-name-keyed",
      { ref: "b" },
      { key: "one" }
    );
    expect(named.id).toBe(direct.id);
    await expect(named.result).resolves.toBe("built a");

    const first = await step.launch(
      "by-name-keyed",
      { ref: "c" },
      { key: "two" }
    );
    const then = await build.launch({ ref: "d" }, { key: "two" });
    expect(then.id).toBe(first.id);
    await expect(then.result).resolves.toBe("built c");

    const flowed = await workflow.launch(
      "by-name-keyed-flow",
      {},
      { key: "f" }
    );
    const again = await flow.launch({}, { key: "f" });
    expect(again.id).toBe(flowed.id);
    await expect(again.result).resolves.toBe("leaf");

    expect(bodies).toBe(3);
    await expect(
      step.launch("by-name-keyed", { ref: "e" }, { key: " " })
    ).rejects.toThrow("a key must be a non-blank string");
  });

  it("launches from an observer, once per key however often the change is delivered", async () => {
    let bodies = 0;
    let deliveries = 0;
    step("by-name-review")
      .input(z.object({ title: z.string() }))
      .do(({ input }) => {
        bodies += 1;
        return `reviewed ${input.title}`;
      });
    const launched: string[] = [];
    observe(
      tasks,
      async (event) => {
        for (const delta of event.tasks) {
          if (delta.before !== null || delta.after === null) {
            continue;
          }
          deliveries += 1;
          const { id } = await step.launch(
            "by-name-review",
            { title: delta.after.title },
            { key: `review:${delta.after.id}` }
          );
          launched.push(id);
          if (deliveries === 1) {
            throw new Error("crashed before saving the run");
          }
          await tasks.update(delta.after.id, { metadata: { run: id } });
        }
      },
      { name: "by-name-dispatcher" }
    );
    const engine = host();
    await engine.start();

    const created = await tasks.create({ title: "first" });
    const run = await vi.waitFor(
      async () => {
        const saved = (await tasks.get(created.id))?.metadata?.run;
        expect(saved).toBeTypeOf("string");
        return saved as string;
      },
      { timeout: 5000 }
    );
    expect(launched).toEqual([run, run]);
    await vi.waitFor(async () =>
      expect((await runs.get(run))?.output).toBe("reviewed first")
    );
    expect(bodies).toBe(1);
  });

  it("from a step body launches once however often the body runs, and hands back the same run", async () => {
    let bodies = 0;
    let children = 0;
    step("by-name-child").do(() => {
      children += 1;
      return "child";
    });
    const parent = step("by-name-parent").do(async ({ ask }) => {
      bodies += 1;
      const launched = await step.launch<string>("by-name-child");
      await ask.question({ title: "Continue?" });
      return { id: launched.id, value: await launched.result };
    });
    const engine = unhosted({ askable: true });
    await engine.start();
    const running = engine.execute<{ id: string; value: string }>(parent, {});
    await answerOpen(engine);
    const outcome = await running;

    expect(bodies).toBe(2);
    expect(children).toBe(1);
    expect(outcome.value).toBe("child");
    expect(engine.executions.get(outcome.id)?.name).toBe("by-name-child");
    expect(
      engine.executions.list().filter((run) => run.name === "by-name-child")
    ).toHaveLength(1);
  });

  it("awaits named children in a separate pool while holding the parent pool", async () => {
    const childDefinition = step("by-name-awaited").do(() => "child");
    const leaf = step("by-name-awaited-leaf").do(() => "flow");
    const flowDefinition = workflow("by-name-awaited-flow", () => leaf());
    const parent = step("by-name-awaiting").do(async () => {
      const child = await step.launch<string>("by-name-awaited");
      const flow = await workflow.launch<string>("by-name-awaited-flow");
      return `${await child.result} and ${await flow.result}`;
    });
    catalog.definitions.delete("by-name-awaited");
    catalog.definitions.delete("by-name-awaited-flow");
    const engine = unhosted({ limit: 1 });
    engine.define(childDefinition, "children");
    engine.define(flowDefinition, "children");
    await engine.start();

    await expect(engine.execute(parent, {})).resolves.toBe("child and flow");
    expect(
      (await engine.executions.pools()).find(
        (pool) => pool.name === DEFAULT_POOL
      )
    ).toMatchObject({ active: 0, waiting: 0 });
  });

  it("launches from a monitor's handler", async () => {
    const root = temporaryDirectory("marbles-by-name-monitor-");
    writeFileSync(join(root, "guide.md"), "one\n");
    const results: string[] = [];
    step("by-name-on-change").do(() => "noticed");
    monitor("**/*.md").do(async () => {
      const launched = await step.launch<string>("by-name-on-change");
      results.push(await launched.result);
    });
    const [key] = [...catalog.monitors.keys()] as [string];
    const engine = testEngine({
      pools: { [DEFAULT_POOL]: { limit: 4 } },
      print: () => undefined,
      root,
    });
    engines.push(engine);
    await engine.start();

    await expect(engine.run(key, {})).resolves.toEqual({ changed: true });
    expect(results).toEqual(["noticed"]);
  });

  it("from a step body refuses a name its engine does not declare, failing the step", async () => {
    const parent = step("by-name-lost").do(() => step.launch("missing"));
    const engine = unhosted();
    await engine.start();

    await expect(engine.execute(parent, {})).rejects.toThrow(UNDECLARED);
  });

  it("handles rejected results when callers launch without awaiting the result", async () => {
    step("by-name-failing").do(() => {
      throw new Error("child failed");
    });
    const parent = step("by-name-fire-and-forget").do(async () => {
      await step.launch("by-name-failing");
      return "launched";
    });
    const engine = host();
    await engine.start();

    await step.launch("by-name-failing");
    await expect(engine.execute(parent, {})).resolves.toBe("launched");
    await vi.waitFor(() => {
      const children = engine.executions
        .list()
        .filter((run) => run.name === "by-name-failing");
      expect(children).toHaveLength(2);
      expect(children.every((run) => run.status === "failed")).toBe(true);
    });
  });

  it("refuses once the engine retires or is disposed", async () => {
    step("by-name-refused").do(() => "never");
    const engine = host();
    await engine.start();
    await engine.retire({ pid: thisProcess().pid + 1, started: null });
    await expect(step.launch("by-name-refused")).rejects.toThrow(RETIRING);
    await engine.dispose();
    await expect(step.launch("by-name-refused")).rejects.toThrow(DISPOSED);
  });
});

describe("step.launch(name) bound to a load", () => {
  it("refuses while the source loads, building no engine", async () => {
    const fallback = vi.fn(() =>
      Promise.reject(new Error("built a fallback engine"))
    );
    setDefaultRuntime(fallback);
    const into = new Catalog();
    let refused: unknown;
    await loadInto(
      "by-name-loading",
      into,
      async (load) => {
        const bound = libraryOfLoad(library, load) as typeof library;
        bound.step("by-name-early").do(() => "early");
        refused = await bound.step
          .launch("by-name-early")
          .catch((error) => error);
      },
      { dry: false }
    );
    expect(refused).toBeInstanceOf(Error);
    expect(String(refused)).toMatch(LOADING);
    expect(fallback).not.toHaveBeenCalled();
    abandonHost("by-name-loading", into);
  });

  it("routes each load's word to its own workspace, from a run of another workspace too, and refuses once that host is disposed", async () => {
    const loaded = async (workspaceId: string, value: string) => {
      const into = new Catalog();
      let words: typeof library | undefined;
      await loadInto(
        workspaceId,
        into,
        (load) => {
          words = libraryOfLoad(library, load) as typeof library;
          words.step("shared-name").do(() => value);
          return Promise.resolve();
        },
        { dry: false }
      );
      if (words === undefined) {
        throw new Error("the load bound no words");
      }
      const engine = testEngine({
        pools: { default: { limit: 4 } },
        print: () => undefined,
        workspaceId,
      });
      declareCatalog(engine, into);
      engines.push(engine);
      setHost(engine, into);
      await engine.start();
      return { engine, into, words };
    };
    const a = await loaded("by-name-a", "from a");
    const b = await loaded("by-name-b", "from b");
    const relay = b.words.step("relay").do(async () => {
      const mine = await b.words.step.launch<string>("shared-name");
      const theirs = await a.words.step.launch<string>("shared-name");
      return {
        mine: await mine.result,
        theirId: theirs.id,
        theirs: await theirs.result,
      };
    });

    const fromA = await a.words.step.launch("shared-name");
    await expect(fromA.result).resolves.toBe("from a");
    expect(a.engine.executions.get(fromA.id)).toBeDefined();
    expect(b.engine.executions.get(fromA.id)).toBeUndefined();
    const fromB = await b.words.step.launch("shared-name");
    await expect(fromB.result).resolves.toBe("from b");

    const relayed = await b.engine.execute<{
      mine: string;
      theirId: string;
      theirs: string;
    }>(relay, {});
    expect(relayed.mine).toBe("from b");
    expect(relayed.theirs).toBe("from a");
    expect(a.engine.executions.get(relayed.theirId)?.name).toBe("shared-name");

    await expect(step.launch("shared-name")).rejects.toThrow(AMBIGUOUS);

    await a.engine.dispose();
    releaseEngine(a.engine);
    await expect(a.words.step.launch("shared-name")).rejects.toThrow(RELEASED);
    const stillB = await b.words.step.launch<string>("shared-name");
    await expect(stillB.result).resolves.toBe("from b");
  });

  it("refuses by-name launch while a reload is still running over a live host", async () => {
    const firstCatalog = new Catalog();
    await loadInto(
      "reload-ws",
      firstCatalog,
      (load) => {
        const words = libraryOfLoad(library, load) as typeof library;
        words.step("old-step").do(() => "old");
        return Promise.resolve();
      },
      { dry: false }
    );
    const engine = testEngine({
      pools: { default: { limit: 4 } },
      print: () => undefined,
      workspaceId: "reload-ws",
    });
    declareCatalog(engine, firstCatalog);
    engines.push(engine);
    setHost(engine, firstCatalog);
    await engine.start();

    const nextCatalog = new Catalog();
    await loadInto(
      "reload-ws",
      nextCatalog,
      async (load) => {
        const words = libraryOfLoad(library, load) as typeof library;
        words.step("fresh-step").do(() => "fresh");
        await expect(words.step.launch("old-step")).rejects.toThrow(
          "not available while its source loads"
        );
        await expect(words.step.launch("fresh-step")).rejects.toThrow(
          "not available while its source loads"
        );
      },
      { dry: false }
    );
  });
});
