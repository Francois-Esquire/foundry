import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { thisProcess } from "@foundry/lib/node/process-identity";
import { DEFAULT_POOL } from "@foundry/queue";
import {
  type CollectInput,
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
import { Catalog } from "~/authoring/catalog";
import { captureScope, releaseEngine, setHost } from "~/authoring/runtime";
import { declareCatalog } from "~/create";
import { DatabaseRunStore } from "~/database/runs";
import type { Engine } from "~/lib/engine";
import { inContext } from "~/lib/execution-context";
import { testEngine } from "./helpers/engine";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";
import { temporaryDirectory } from "./helpers/temporary";

const BLANK = /give it the name of a (step|workflow) the workspace declares/;
const UNDECLARED = /declares no step or workflow named "missing"/;
const NOT_A_WORKFLOW =
  /"by-name-leaf" is a step, not a workflow; use step\.enqueue\("by-name-leaf"\)/;
const NOT_A_STEP =
  /"by-name-flow" is a workflow, not a step; use workflow\.enqueue\("by-name-flow"\)/;
const RETIRING = /this engine is retiring/;
const DISPOSED = /host that held these runs was disposed; nothing was enqueued/;
const RELEASED = /no longer hosted in this process/;
const AMBIGUOUS = /hosts 2 workspaces/;

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
  options: { askable?: boolean; collect?: CollectInput } = {}
): Engine {
  const state = machine.workspace();
  const records = machine.records(state);
  const engine = testEngine({
    askable: options.askable ?? false,
    ...(options.collect === undefined ? {} : { collect: options.collect }),
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

function unhosted(
  options: { askable?: boolean; collect?: CollectInput; limit?: number } = {}
): Engine {
  const engine = testEngine({
    askable: options.askable ?? false,
    ...(options.collect === undefined ? {} : { collect: options.collect }),
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

describe("step.enqueue(name) and workflow.enqueue(name)", () => {
  it("launches the step or workflow the workspace declares by that name, with the input it is given", async () => {
    const build = step("by-name-build")
      .input(z.object({ ref: z.string() }))
      .do(({ input }) => `built ${input.ref}`);
    const leaf = step("by-name-leaf").do(() => "leaf");
    const flow = workflow("by-name-flow", () => leaf());
    const engine = host({ collect: { build, flow, leaf } });
    await engine.start();

    const built = await step.enqueue<string>("by-name-build", { ref: "main" });
    await expect(built.result).resolves.toBe("built main");
    expect((await runs.get(built.id))?.name).toBe("by-name-build");
    const flowed = await workflow.enqueue("by-name-flow");
    await expect(flowed.result).resolves.toBe("leaf");
    expect((await runs.get(flowed.id))?.name).toBe("by-name-flow");
  });

  it("refuses a blank name, a name the workspace does not declare, a monitor's key, and the other kind", async () => {
    const leaf = step("by-name-leaf").do(() => "leaf");
    const flow = workflow("by-name-flow", () => leaf());
    const notes = monitor("notes/*.md").do(() => undefined);
    const engine = host({ collect: { flow, leaf, notes } });
    await engine.start();

    await expect(step.enqueue("")).rejects.toThrow(BLANK);
    await expect(workflow.enqueue("   ")).rejects.toThrow(BLANK);
    await expect(
      step.enqueue(undefined as unknown as string)
    ).rejects.toBeInstanceOf(TypeError);
    await expect(step.enqueue("missing")).rejects.toThrow(UNDECLARED);
    await expect(workflow.enqueue("missing")).rejects.toThrow(UNDECLARED);
    await expect(step.enqueue(notes.key)).rejects.toThrow(
      "declares no step or workflow"
    );
    await expect(workflow.enqueue("by-name-leaf")).rejects.toThrow(
      NOT_A_WORKFLOW
    );
    await expect(step.enqueue("by-name-flow")).rejects.toThrow(NOT_A_STEP);
    expect(engine.executions.list()).toHaveLength(0);
  });

  it("shares one key with the definition's own enqueue, whichever comes first", async () => {
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
    const engine = host({ collect: { build, flow, leaf } });
    await engine.start();

    const direct = await build.enqueue({ ref: "a" }, { key: "one" });
    const named = await step.enqueue(
      "by-name-keyed",
      { ref: "b" },
      { key: "one" }
    );
    expect(named.id).toBe(direct.id);
    await expect(named.result).resolves.toBe("built a");

    const first = await step.enqueue(
      "by-name-keyed",
      { ref: "c" },
      { key: "two" }
    );
    const then = await build.enqueue({ ref: "d" }, { key: "two" });
    expect(then.id).toBe(first.id);
    await expect(then.result).resolves.toBe("built c");

    const flowed = await workflow.enqueue(
      "by-name-keyed-flow",
      {},
      { key: "f" }
    );
    const again = await flow.enqueue({}, { key: "f" });
    expect(again.id).toBe(flowed.id);
    await expect(again.result).resolves.toBe("leaf");

    expect(bodies).toBe(3);
    await expect(
      step.enqueue("by-name-keyed", { ref: "e" }, { key: " " })
    ).rejects.toThrow("a key must be a non-blank string");
  });

  it("launches from an observer, once per key however often the change is delivered", async () => {
    let bodies = 0;
    let deliveries = 0;
    const review = step("by-name-review")
      .input(z.object({ title: z.string() }))
      .do(({ input }) => {
        bodies += 1;
        return `reviewed ${input.title}`;
      });
    const launched: string[] = [];
    const dispatcher = observe(
      tasks,
      async (event) => {
        for (const delta of event.tasks) {
          if (delta.before !== null || delta.after === null) {
            continue;
          }
          deliveries += 1;
          const { id } = await step.enqueue(
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
    const engine = host({ collect: { dispatcher, review } });
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
    const child = step("by-name-child").do(() => {
      children += 1;
      return "child";
    });
    const parent = step("by-name-parent").do(async ({ ask }) => {
      bodies += 1;
      const launched = await step.enqueue<string>("by-name-child");
      await ask.question({ title: "Continue?" });
      return { id: launched.id, value: await launched.result };
    });
    const engine = unhosted({ askable: true, collect: { child, parent } });
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
      const child = await step.enqueue<string>("by-name-awaited");
      const flow = await workflow.enqueue<string>("by-name-awaited-flow");
      return `${await child.result} and ${await flow.result}`;
    });
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
    const onChange = step("by-name-on-change").do(() => "noticed");
    const watchMd = monitor("**/*.md").do(async () => {
      const launched = await step.enqueue<string>("by-name-on-change");
      results.push(await launched.result);
    });
    const engine = testEngine({
      collect: { onChange, watchMd },
      pools: { [DEFAULT_POOL]: { limit: 4 } },
      print: () => undefined,
      root,
    });
    engines.push(engine);
    await engine.start();

    await expect(engine.run(watchMd.key, {})).resolves.toEqual({
      changed: true,
    });
    expect(results).toEqual(["noticed"]);
  });

  it("from a step body refuses a name its engine does not declare, failing the step", async () => {
    const parent = step("by-name-lost").do(() => step.enqueue("missing"));
    const engine = unhosted();
    await engine.start();

    await expect(engine.execute(parent, {})).rejects.toThrow(UNDECLARED);
  });

  it("handles rejected results when callers launch without awaiting the result", async () => {
    const failing = step("by-name-failing").do(() => {
      throw new Error("child failed");
    });
    const parent = step("by-name-fire-and-forget").do(async () => {
      await step.enqueue("by-name-failing");
      return "launched";
    });
    const engine = host({ collect: { failing, parent } });
    await engine.start();

    await step.enqueue("by-name-failing");
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
    const refused = step("by-name-refused").do(() => "never");
    const engine = host({ collect: { refused } });
    await engine.start();
    await engine.retire({ pid: thisProcess().pid + 1, started: null });
    await expect(step.enqueue("by-name-refused")).rejects.toThrow(RETIRING);
    await engine.dispose();
    await expect(step.enqueue("by-name-refused")).rejects.toThrow(DISPOSED);
  });
});

describe("step.enqueue(name) across multiple hosted workspaces", () => {
  it("routes each workspace's runs and captured scope to its own host, and refuses once disposed", async () => {
    const setup = async (workspaceId: string, value: string) => {
      const shared = step("shared-name").do(() => value);
      const into = Catalog.collect({ shared });
      const engine = testEngine({
        pools: { default: { limit: 4 } },
        print: () => undefined,
        workspaceId,
      });
      declareCatalog(engine, into);
      engines.push(engine);
      setHost(engine, into);
      await engine.start();
      const scope = inContext(engine.context, captureScope);
      return { engine, into, scope };
    };
    const a = await setup("by-name-a", "from a");
    const b = await setup("by-name-b", "from b");

    const fromA = await a.scope(() => step.enqueue<string>("shared-name"));
    await expect(fromA.result).resolves.toBe("from a");
    expect(a.engine.executions.get(fromA.id)).toBeDefined();
    expect(b.engine.executions.get(fromA.id)).toBeUndefined();
    const fromB = await b.scope(() => step.enqueue<string>("shared-name"));
    await expect(fromB.result).resolves.toBe("from b");

    await expect(step.enqueue("shared-name")).rejects.toThrow(AMBIGUOUS);

    await a.engine.dispose();
    releaseEngine(a.engine);
    await expect(a.scope(() => step.enqueue("shared-name"))).rejects.toThrow(
      RELEASED
    );
    const stillB = await b.scope(() => step.enqueue<string>("shared-name"));
    await expect(stillB.result).resolves.toBe("from b");
  });
});
