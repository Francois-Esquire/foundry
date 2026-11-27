import { Tasks } from "@foundry/tasks";
import type { TaskEvent } from "@foundry.sh/marbles";
import {
  agent,
  artifact,
  Catalog,
  observe,
  sandbox,
  step,
  tasks,
  workflow,
  workspace,
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
import type { CollectInput } from "~/authoring/catalog";
import { setHost } from "~/authoring/runtime";
import type { Engine } from "~/lib/engine";
import { TASKS } from "~/lib/events/source";
import { current } from "~/lib/run-scope";
import { testEngine } from "./helpers/engine";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";
import { temporaryDirectory } from "./helpers/temporary";

const NOT_A_SOURCE = /not something Marbles emits/;
const DISPOSED = /host that held these tasks was disposed/;

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
});

function host(state: string, askable = false, collect?: CollectInput): Engine {
  const engine = testEngine({
    askable,
    collect,
    print: () => undefined,
    records: machine.records(state),
    state,
  });
  engines.push(engine);
  setHost(engine);
  return engine;
}

describe("tasks", () => {
  it("is one backlog the package creates and exports", async () => {
    expect(tasks).toBeInstanceOf(Tasks);
    const again = await import("@foundry.sh/marbles");
    expect(again.tasks).toBe(tasks);
  });

  it("is held in memory in a script no host loaded", async () => {
    const task = await tasks.create({ title: "Scripted" });
    expect((await tasks.get(task.id))?.title).toBe("Scripted");
  });

  it("is the host's workspace tasks, delivered to what the source observes", async () => {
    const seen: TaskEvent[] = [];
    const obs = observe(
      tasks,
      (payload) => {
        seen.push(payload);
      },
      { name: "hosted" }
    );
    const state = machine.workspace();
    const engine = host(state, false, [obs]);
    await engine.start();

    const task = await tasks.create({ tags: ["review"], title: "Hosted" });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.tasks[0]?.after).toEqual(task);
    const stored = async (dir: string) => {
      const records = machine.records(dir);
      try {
        return (await records.taskStore.snapshot()).tasks.map(
          (item) => item.id
        );
      } finally {
        await records.close();
      }
    };
    expect(await stored(state)).toEqual([task.id]);

    await engine.dispose();
    await expect(tasks.create({ title: "Late" })).rejects.toThrow(DISPOSED);
    await expect(tasks.list()).rejects.toThrow(DISPOSED);

    const nextState = machine.workspace();
    const next = host(nextState);
    await next.start();
    expect((await tasks.list()).items).toEqual([]);
    const moved = await tasks.create({ title: "Next workspace" });
    expect((await tasks.list()).items.map((item) => item.id)).toEqual([
      moved.id,
    ]);
    expect(await stored(state)).toEqual([task.id]);
  });

  it("a handler's call starts its own run, even when a step's write woke delivery; a call in a step body still joins that step's run", async () => {
    const ids: Record<string, string> = {};
    const asked = step("observed-question").do(async ({ ask, run }) => {
      ids.asked = run.id;
      return await ask.question({ title: "Proceed?" });
    });
    const nested = step("nested-call").do(({ run }) => {
      ids.nested = run.id;
      return "nested";
    });
    const writer = step("waking-writer").do(async ({ run }) => {
      ids.writer = run.id;
      await tasks.create({ title: "Trigger" });
      return await nested.run();
    });
    const triggerObs = observe(
      tasks,
      (event) => {
        if (event.tasks.some((delta) => delta.after?.title === "Trigger")) {
          ids.handler = current.getStore()?.scope.id ?? "outside any run";
          asked.run().catch(() => undefined);
        }
      },
      { name: "trigger" }
    );
    const declarations = [asked, nested, writer, triggerObs];
    const state = temporaryDirectory("marbles-tasks-");
    const first = host(state, true, declarations);
    await first.start();
    await new Promise((done) => setTimeout(done, 0));

    await expect(writer.run()).resolves.toBe("nested");
    expect(ids.nested).toBe(ids.writer);
    const suspended = await vi.waitFor(async () => {
      const found = (await first.runs()).find(
        (run) => run.step === "observed-question"
      );
      expect(found?.status).toBe("suspended");
      return found;
    });
    expect(ids.handler).toBe("outside any run");
    expect(suspended?.id).toBe(ids.asked);
    expect(ids.asked).not.toBe(ids.writer);
    expect(
      (await first.runs()).find((run) => run.id === ids.writer)?.status
    ).toBe("complete");

    await first.stop({ cancel: true });
    await first.dispose();
    engines.splice(engines.indexOf(first), 1);
    const next = host(state, true, declarations);
    await next.start();
    const question = await vi.waitFor(async () => {
      const open = (await next.feed()).find(
        (entry) => entry.input?.status === "open"
      );
      expect(open).toBeDefined();
      return open;
    });
    await next.answer(question?.id ?? "", "yes");
    await vi.waitFor(async () =>
      expect(
        (await next.runs()).find((run) => run.id === ids.asked)?.status
      ).toBe("complete")
    );
    expect(
      (await next.runs()).filter((run) => run.step === "observed-question")
    ).toHaveLength(1);
  });

  it("an engine built inside a step body delivers outside that step's run", async () => {
    const seen: string[] = [];
    let inner: Engine | undefined;
    const builder = step("engine-builder").do(async ({ run }) => {
      inner = testEngine({
        print: () => undefined,
        state: temporaryDirectory("marbles-inner-"),
      });
      engines.push(inner);
      inner.observe(
        TASKS,
        () => {
          seen.push(current.getStore()?.scope.id ?? "outside any run");
        },
        { name: "inner" }
      );
      await inner.start();
      return run.id;
    });
    const outer = host(temporaryDirectory("marbles-tasks-"));
    await outer.start();
    const builderRun = await builder.run();
    if (inner === undefined) {
      throw new Error("unreachable");
    }

    await new Tasks({ store: inner.taskStore }).create({ title: "Outside" });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const store = inner.taskStore;
    await step("inner-writer")
      .do(async () => {
        await new Tasks({ store }).create({ title: "Inside" });
      })
      .run();
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen).toEqual(["outside any run", "outside any run"]);
    expect(seen).not.toContain(builderRun);
  });

  it("observe takes a source, a handler, and how the observer is named and what it is handed", () => {
    expect(() =>
      // @ts-expect-error A plain Tasks is not something Marbles emits.
      observe(new Tasks(), () => undefined, { name: "plain" })
    ).toThrow(NOT_A_SOURCE);
    // @ts-expect-error Only a name and types.
    const extra = observe(tasks, () => undefined, { id: "x", name: "extra" });
    const typed = observe(
      tasks,
      (payload) => {
        // @ts-expect-error The payload is the source's.
        expect(payload.missing).toBeUndefined();
      },
      { name: "typed" }
    );
    expect(typed).toMatchObject({
      kind: "observer",
      name: "typed",
      source: "tasks",
    });
    const handed: string[] = [];
    const byFunctionObs = observe(tasks, function byFunction(payload) {
      handed.push(payload.type);
    });
    expect(byFunctionObs).toMatchObject({ name: "byFunction" });
    const runs = observe(
      workflow,
      (run) => {
        handed.push(run.runId);
      },
      { name: "runs", types: ["run.failed"] }
    );
    expect(runs).toMatchObject({
      kind: "observer",
      name: "runs",
      source: "runs",
    });
    const a = observe(artifact, () => undefined, { name: "a" });
    const s = observe(sandbox, () => undefined, { name: "s" });
    const w = observe(workspace, () => undefined, { name: "w" });
    const g = observe(agent, () => undefined, { name: "g" });
    expect(a.source).toBe("artifacts");
    expect(s.source).toBe("sandboxes");
    expect(w.source).toBe("workspaces");
    expect(g.source).toBe("sessions");
    // @ts-expect-error A type the source does not emit.
    const bad = observe(workflow, () => undefined, {
      name: "bad",
      types: ["nope"],
    });
    const unnamed = observe(tasks, () => undefined);
    expect(() => Catalog.collect([unnamed])).toThrow("name this observer");
    const dup = observe(tasks, () => undefined, { name: "typed" });
    expect(() => Catalog.collect([typed, dup])).toThrow(
      'named "typed" is already declared'
    );
    const collected = Catalog.collect([
      extra,
      typed,
      byFunctionObs,
      runs,
      a,
      s,
      w,
      g,
      bad,
    ]);
    expect(collected.observers.map((observer) => observer.name)).toEqual([
      "extra",
      "typed",
      "byFunction",
      "runs",
      "a",
      "s",
      "w",
      "g",
      "bad",
    ]);
    expect(collected.observers[3]?.types).toEqual(["run.failed"]);
  });
});
