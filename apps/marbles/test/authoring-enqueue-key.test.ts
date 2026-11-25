import { basename } from "node:path";
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
import { releaseEngine, setHost } from "~/authoring/runtime";
import { DatabaseRunStore } from "~/database/runs";
import type { Engine } from "~/lib/engine";
import { testEngine } from "./helpers/engine";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";

const NO_NAME = /a key is matched by the definition's name/;
const BLANK = /a key must be a non-blank string/;
const BROKE = /broke/;

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

function host(state = machine.workspace()): Engine {
  const records = machine.records(state);
  const engine = testEngine({
    pools: { default: 4 },
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

describe(".enqueue(input, { key })", () => {
  it("hands back the run a key already launched, while it runs and once it is done, with its result", async () => {
    const release = Promise.withResolvers<void>();
    let bodies = 0;
    const build = step("keyed-build")
      .input(z.object({ ref: z.string() }))
      .do(async ({ input }) => {
        bodies += 1;
        await release.promise;
        return `built ${input.ref}`;
      });
    const engine = host();
    await engine.start();

    const first = await build.enqueue({ ref: "main" }, { key: "task-1" });
    expect(engine.executions.get(first.id)?.source).toBeUndefined();
    const again = await build.enqueue({ ref: "main" }, { key: "task-1" });
    expect(again.id).toBe(first.id);
    release.resolve();
    await expect(first.result).resolves.toBe("built main");
    await expect(again.result).resolves.toBe("built main");

    const after = await build.enqueue({ ref: "other" }, { key: "task-1" });
    expect(after.id).toBe(first.id);
    await expect(after.result).resolves.toBe("built main");
    expect(bodies).toBe(1);
    expect(
      engine.executions.list().filter((run) => run.name === "keyed-build")
    ).toHaveLength(1);

    const other = await build.enqueue({ ref: "next" }, { key: "task-2" });
    expect(other.id).not.toBe(first.id);
    await expect(other.result).resolves.toBe("built next");
  });

  it("matches a run that failed under the key too, handing back its failure rather than launching again", async () => {
    let bodies = 0;
    const flaky = step("keyed-flaky").do(() => {
      bodies += 1;
      throw new Error("broke");
    });
    const engine = host();
    await engine.start();

    const first = await flaky.enqueue({}, { key: "once" });
    await expect(first.result).rejects.toThrow(BROKE);
    const again = await flaky.enqueue({}, { key: "once" });
    expect(again.id).toBe(first.id);
    await expect(again.result).rejects.toThrow(BROKE);
    expect(bodies).toBe(1);
  });

  it("refuses a key on a definition the workspace does not declare by name, and a blank key", async () => {
    const leaf = step("keyed-leaf").do(() => "leaf");
    const anonymous = workflow(() => leaf());
    const engine = host();
    await engine.start();

    await expect(anonymous.enqueue({}, { key: "k" })).rejects.toThrow(NO_NAME);
    await expect(leaf.enqueue({}, { key: " " })).rejects.toThrow(BLANK);
    const undeclared = step("not-declared-on-engine").do(() => "late");
    await expect(undeclared.enqueue({}, { key: "k" })).rejects.toThrow(NO_NAME);
    await expect(
      leaf.enqueue({}, { key: 1 as unknown as string })
    ).rejects.toThrow(BLANK);
    await expect(anonymous.enqueue()).resolves.toMatchObject({});
  });

  it("launches once for an observer that throws after launching and is delivered the change again", async () => {
    let bodies = 0;
    let deliveries = 0;
    const review = step("keyed-review")
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
          const { id } = await review.enqueue(
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
      { name: "keyed-dispatcher" }
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
    expect(deliveries).toBe(2);
    expect(launched).toEqual([run, run]);
    await vi.waitFor(async () =>
      expect((await runs.get(run))?.output).toBe("reviewed first")
    );
    expect(bodies).toBe(1);
  });

  it("finds the run a key launched on an engine that is gone, from the next engine on the same state", async () => {
    const definitions = () =>
      step("keyed-handover")
        .input(z.object({ ref: z.string() }))
        .do(({ input }) => `built ${input.ref}`);
    const state = machine.workspace();
    const before = definitions();
    const first = host(state);
    await first.start();
    const launched = await before.enqueue({ ref: "a" }, { key: "k" });
    await expect(launched.result).resolves.toBe("built a");
    await first.dispose();
    releaseEngine(first);
    catalog.reset();

    const after = definitions();
    const second = host(state);
    await second.start();
    const again = await after.enqueue({ ref: "b" }, { key: "k" });
    expect(again.id).toBe(launched.id);
    await expect(again.result).resolves.toBe("built a");
    expect(
      second.executions.list().filter((run) => run.name === "keyed-handover")
    ).toHaveLength(1);
  });

  it("waits for a keyed run executing in another engine to settle and returns its result or failure", async () => {
    const release = Promise.withResolvers<void>();
    const failRelease = Promise.withResolvers<void>();
    let okBodies = 0;
    let failBodies = 0;
    const declare = () => ({
      build: step("keyed-remote")
        .input(z.object({ ref: z.string() }))
        .do(async ({ input }) => {
          okBodies += 1;
          await release.promise;
          return `remote ${input.ref}`;
        }),
      flaky: step("keyed-remote-fail").do(async () => {
        failBodies += 1;
        await failRelease.promise;
        throw new Error("broke");
      }),
    });
    const state = machine.workspace();
    const open = () => {
      const records = machine.records(state);
      const engine = testEngine({
        pools: { default: 4 },
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
      return engine;
    };
    const firstDefs = declare();
    const first = open();
    await first.start();

    catalog.reset();
    const secondDefs = declare();
    const second = open();
    await second.start();

    const okOne = await first.enqueueDefinition<string>(
      firstDefs.build,
      { ref: "main" },
      { key: "k-ok" }
    );
    const failOne = await first.enqueueDefinition(
      firstDefs.flaky,
      {},
      { key: "k-fail" }
    );

    const okTwo = await second.enqueueDefinition<string>(
      secondDefs.build,
      { ref: "other" },
      { key: "k-ok" }
    );
    const failTwo = await second.enqueueDefinition(
      secondDefs.flaky,
      {},
      { key: "k-fail" }
    );
    expect(okTwo.id).toBe(okOne.id);
    expect(failTwo.id).toBe(failOne.id);

    release.resolve();
    failRelease.resolve();
    await expect(okOne.result).resolves.toBe("remote main");
    await expect(okTwo.result).resolves.toBe("remote main");
    await expect(failOne.result).rejects.toThrow(BROKE);
    await expect(failTwo.result).rejects.toThrow(BROKE);
    expect(okBodies).toBe(1);
    expect(failBodies).toBe(1);
  });

  it("from a step body launches the keyed run once, however often the body runs", async () => {
    let children = 0;
    const child = step("keyed-child").do(() => {
      children += 1;
      return "child";
    });
    const parent = step("keyed-parent").do(async () => {
      const one = await child.enqueue({}, { key: "shared" });
      const two = await child.enqueue({}, { key: "shared" });
      return { same: one.id === two.id, value: await two.result };
    });
    const engine = host();
    await engine.start();

    await expect(engine.execute(parent, {})).resolves.toEqual({
      same: true,
      value: "child",
    });
    expect(children).toBe(1);
  });
});

it.each(["stop", "dispose"] as const)(
  "%s wakes a nonlocal result waiter without ending the owner's run",
  async (action) => {
    const release = Promise.withResolvers<void>();
    const definition = step("remote-close").do(async () => {
      await release.promise;
      return "done";
    });
    const state = machine.workspace();
    const owner = host(state);
    await owner.start();
    const launched = await owner.enqueueDefinition<string>(
      definition,
      {},
      { key: "close" }
    );
    const observer = host(state);
    await observer.start();
    const remote = await observer.enqueueDefinition<string>(
      definition,
      {},
      { key: "close" }
    );
    const rejected = expect(remote.result).rejects.toThrow(
      "engine is stopping"
    );
    await observer[action]();
    await rejected;
    release.resolve();
    await expect(launched.result).resolves.toBe("done");
  }
);

it("graceful stop lets a draining in-run parent finish awaiting a nonlocal keyed child", async () => {
  const release = Promise.withResolvers<void>();
  const parentEntered = Promise.withResolvers<void>();
  const state = machine.workspace();

  const childA = step("remote-child").do(async () => {
    await release.promise;
    return "child-ok";
  });
  const owner = host(state);
  await owner.start();
  const childRun = await owner.enqueueDefinition<string>(
    childA,
    {},
    { key: "drain-key" }
  );

  catalog.reset();
  const childB = step("remote-child").do(() => "unused");
  const parentB = step("draining-parent").do(async () => {
    const joined = await childB.enqueue({}, { key: "drain-key" });
    parentEntered.resolve();
    return `parent:${await joined.result}`;
  });
  const peer = host(state);
  await peer.start();
  const parentRun = await peer.enqueueDefinition<string>(parentB, {});
  await parentEntered.promise;

  const stopping = peer.stop();
  release.resolve();
  await expect(childRun.result).resolves.toBe("child-ok");
  await expect(parentRun.result).resolves.toBe("parent:child-ok");
  await stopping;
});

it("stop() before start() does not poison later nonlocal result lookups", async () => {
  const state = machine.workspace();
  const childA = step("pre-stop-child").do(() => "ready");
  const owner = host(state);
  await owner.start();
  await expect(
    owner
      .enqueueDefinition<string>(childA, {}, { key: "pre-stop" })
      .then((run) => run.result)
  ).resolves.toBe("ready");

  catalog.reset();
  const childB = step("pre-stop-child").do(() => "unused");
  const peer = host(state);
  await peer.stop();
  await peer.start();
  const joined = await peer.enqueueDefinition<string>(
    childB,
    {},
    { key: "pre-stop" }
  );
  await expect(joined.result).resolves.toBe("ready");
});
