import { Tasks } from "@foundry/tasks";
import type { TaskEvent } from "@foundry.sh/marbles";
import { observe, step, tasks } from "@foundry.sh/marbles";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { catalog } from "~/authoring/catalog";
import { expectHost, setHost } from "~/authoring/runtime";
import type { Engine } from "~/lib/engine";
import { TASKS } from "~/lib/events/source";
import { current } from "~/lib/run-scope";
import { testEngine } from "./helpers/engine";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";
import { temporaryDirectory } from "./helpers/temporary";

const NOT_A_SOURCE = /not something Marbles emits/;
const DISPOSED = /host that held these tasks was disposed/;
const LOADING = /not available while its source loads/;

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

function host(state: string, askable = false): Engine {
  const engine = testEngine({
    askable,
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

  // First, while this file's process has never been a host.
  it("is held in memory in a script no host loaded", async () => {
    const task = await tasks.create({ title: "Scripted" });
    expect((await tasks.get(task.id))?.title).toBe("Scripted");
  });

  it("is the host's workspace tasks, delivered to what the source observes", async () => {
    const seen: TaskEvent[] = [];
    observe(tasks, (payload) => {
      seen.push(payload);
    });
    const state = machine.workspace();
    const engine = host(state);
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

    expectHost();
    await expect(tasks.list()).rejects.toThrow(LOADING);

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
    observe(tasks, (event) => {
      if (event.tasks.some((delta) => delta.after?.title === "Trigger")) {
        ids.handler = current.getStore()?.scope.id ?? "outside any run";
        asked.run().catch(() => undefined);
      }
    });
    const state = temporaryDirectory("marbles-tasks-");
    const first = host(state, true);
    await first.start();
    // The start's own pass has no items and no I/O; once it is over, the
    // writer's commit is what starts the next pass, as its turn ends.
    await new Promise((done) => setTimeout(done, 0));

    await expect(writer.run()).resolves.toBe("nested");
    expect(ids.nested).toBe(ids.writer);
    const parked = await vi.waitFor(async () => {
      const found = (await first.runs()).find(
        (run) => run.step === "observed-question"
      );
      expect(found?.status).toBe("suspended");
      return found;
    });
    expect(ids.handler).toBe("outside any run");
    expect(parked?.id).toBe(ids.asked);
    expect(ids.asked).not.toBe(ids.writer);
    expect(
      (await first.runs()).find((run) => run.id === ids.writer)?.status
    ).toBe("complete");

    // Parked on its own, it outlives the host and is answered in the next.
    await first.stop({ cancel: true });
    await first.dispose();
    engines.splice(engines.indexOf(first), 1);
    const next = host(state, true);
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
      inner.observe(TASKS, () => {
        seen.push(current.getStore()?.scope.id ?? "outside any run");
      });
      await inner.start();
      return run.id;
    });
    const outer = host(temporaryDirectory("marbles-tasks-"));
    await outer.start();
    const builderRun = await builder.run();
    if (inner === undefined) {
      throw new Error("unreachable");
    }

    // Written outside any run, and again from inside another step.
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

  it("observe takes a source and a handler, and nothing else", () => {
    expect(() =>
      // @ts-expect-error A plain Tasks is not something Marbles emits.
      observe(new Tasks(), () => undefined)
    ).toThrow(NOT_A_SOURCE);
    // @ts-expect-error No options.
    observe(tasks, () => undefined, { id: "x" });
    expect(
      observe(tasks, (payload) => {
        // @ts-expect-error The payload is the source's.
        expect(payload.missing).toBeUndefined();
      })
    ).toBeUndefined();
    expect(catalog.observers).toHaveLength(2);
  });
});
