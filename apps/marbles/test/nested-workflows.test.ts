import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowDefinition } from "@foundry.sh/marbles";
import { step, workflow } from "@foundry.sh/marbles";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { catalog } from "~/authoring/catalog";
import type { Engine } from "~/lib/engine";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import type { StepSnapshot } from "~/model/dashboard";
import { dashboardSnapshot } from "~/workspace/snapshot";
import { startEngine } from "./helpers/engine";
import { openFeed } from "./helpers/feed";

const SELF_NESTED = /a workflow cannot be locked inside itself/;
const RESERVED_WORKFLOW_CHILD = /reserved for nested workflows/;
const CHAIN = /"ping" → "pong" → "ping"/;
const BROKE = /broke/;
const CANCELLED = /cancelled/;

let root: string;
const engines: Engine[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marbles-nested-"));
});

afterEach(async () => {
  await Promise.allSettled(engines.splice(0).map((engine) => engine.dispose()));
  catalog.reset();
  await rm(root, { force: true, recursive: true });
});

async function engineFor(
  options: Parameters<typeof startEngine>[0] = {}
): Promise<Engine> {
  const engine = await startEngine({
    print: () => undefined,
    root,
    ...options,
  });
  engines.push(engine);
  return engine;
}

async function openQuestion(
  read: () => Promise<readonly FeedEntrySnapshot[]>
): Promise<FeedEntrySnapshot> {
  return await vi.waitFor(async () => {
    const open = (await read()).find((entry) => entry.input?.status === "open");
    expect(open).toBeDefined();
    return open as FeedEntrySnapshot;
  });
}

function incrementing() {
  const paths: string[][] = [];
  const add = step("add")
    .input(z.object({ n: z.number() }))
    .do(({ input, run }) => {
      paths.push([...run.path]);
      return input.n + 1;
    });
  const plusOne = workflow("plus-one")
    .input(z.object({ n: z.number() }))
    .do(({ input }) => add({}, { n: input.n }));
  const sum = step("sum")
    .input(z.object({ a: z.number(), b: z.number() }))
    .do(({ input }) => input.a + input.b);
  return { paths, plusOne, sum };
}

describe("a workflow locked inside another", () => {
  it("runs two nested workflows in series, its steps a subtree under the place it is locked", async () => {
    const { paths, plusOne, sum } = incrementing();
    const outer = workflow("outer", () =>
      sum({ a: plusOne({}, { n: 1 }), b: plusOne({}, { n: 10 }) })
    );
    const engine = await engineFor();

    await expect(engine.execute(outer, {})).resolves.toBe(13);
    expect(paths).toEqual([
      ["outer", "a", "$workflow"],
      ["outer", "b", "$workflow"],
    ]);
  });

  it("shows a nested workflow's steps on the dashboard as a subtree of the place it is locked", async () => {
    const { plusOne, sum } = incrementing();
    workflow("shown", () =>
      sum({ a: plusOne({}, { n: 1 }), b: plusOne({}, { n: 2 }) })
    );
    const engine = await engineFor();
    const launched = await engine.launch<number>("shown", {});
    await expect(launched.result).resolves.toBe(5);

    const [row] = dashboardSnapshot(await engine.runs(), {
      definitions: [],
      monitors: new Map(),
      queued: engine.executions.list(),
      root,
      schedules: [],
      startedAt: Date.now(),
      status: "running",
    }).runs;
    const shape = (node: StepSnapshot): unknown => [
      node.name,
      node.status,
      node.children.map(shape),
    ];
    expect(row?.steps.map(shape)).toEqual([
      [
        "shown",
        "complete",
        [
          ["a", "complete", [["$workflow", "complete", []]]],
          ["b", "complete", [["$workflow", "complete", []]]],
        ],
      ],
    ]);
  });

  it("runs nested workflows side by side under .parallel", async () => {
    const arrived: string[] = [];
    const both = Promise.withResolvers<void>();
    const wait = step("wait")
      .input(z.object({ label: z.string() }))
      .do(async ({ input }) => {
        arrived.push(input.label);
        if (arrived.length === 2) {
          both.resolve();
        }
        await both.promise;
        return input.label;
      });
    const waiting = workflow("waiting")
      .input(z.object({ label: z.string() }))
      .do(({ input }) => wait({}, { label: input.label }));
    const joined = step("join")
      .input(z.object({ a: z.string(), b: z.string() }))
      .do(({ input }) => `${input.a}+${input.b}`);
    const outer = workflow("side-by-side", () =>
      joined.parallel({
        a: waiting({}, { label: "left" }),
        b: waiting({}, { label: "right" }),
      })
    );
    const engine = await engineFor();

    await expect(engine.execute(outer, {})).resolves.toBe("left+right");
  });

  it("sets a nested workflow up from what its children returned, once they have", async () => {
    const order: string[] = [];
    const fetchName = step("fetch-name").do(() => {
      order.push("fetch");
      return "ada";
    });
    const shout = step("shout")
      .input(z.object({ text: z.string() }))
      .do(({ input }) => input.text.toUpperCase());
    const greet = workflow("greet")
      .input(z.object({ name: z.string() }))
      .do(({ input }) => {
        order.push(`setup ${input.name}`);
        return shout({}, { text: `hi ${input.name}` });
      });
    const wrap = step("wrap")
      .input(z.object({ greeting: z.string() }))
      .do(({ input }) => `[${input.greeting}]`);
    const outer = workflow("greeting", () =>
      wrap({ greeting: greet({ name: fetchName() }) })
    );
    const engine = await engineFor();

    await expect(engine.execute(outer, {})).resolves.toBe("[HI ADA]");
    expect(order).toEqual(["fetch", "setup ada"]);
  });

  it("runs a workflow whose root is another workflow, and one a step calls with .run()", async () => {
    const { plusOne } = incrementing();
    const rooted = workflow("rooted", () => plusOne({}, { n: 4 }));
    const caller = step("caller").do(
      async () => `got ${String(await rooted.run())}`
    );
    const engine = await engineFor();

    await expect(engine.execute(rooted, {})).resolves.toBe(5);
    await expect(engine.execute(caller, {})).resolves.toBe("got 5");
  });

  it("refuses a workflow locked inside itself, directly or through another, and lets .run() recurse", async () => {
    const selfish: WorkflowDefinition = workflow("selfish").do(() => selfish());
    const ping: WorkflowDefinition = workflow("ping").do(() => pong());
    const pong: WorkflowDefinition = workflow("pong").do(() => ping());
    const countdown = step("countdown")
      .input(z.object({ n: z.number() }))
      .do(async ({ input }): Promise<number> => {
        if (input.n === 0) {
          return 0;
        }
        return (await counting.run({ n: input.n - 1 })) + 1;
      });
    const counting: WorkflowDefinition<{ n: number }, number> = workflow(
      "counting"
    )
      .input(z.object({ n: z.number() }))
      .do(({ input }) => countdown({}, { n: input.n }));
    const engine = await engineFor();

    await expect(engine.execute(selfish, {})).rejects.toThrow(SELF_NESTED);
    await expect(engine.execute(ping, {})).rejects.toThrow(CHAIN);
    await expect(engine.execute(counting, { n: 3 })).resolves.toBe(3);
  });

  it("retries a failed nested workflow with its parent as it retries a plain child, running its failed steps again in place", async () => {
    const engine = await engineFor();
    const outcomes: { calls: number; settled: string }[] = [];
    const paths: string[] = [];
    for (const nested of [false, true]) {
      let calls = 0;
      const flaky = step(`flaky-${String(nested)}`).do(({ run }): string => {
        calls += 1;
        if (nested) {
          paths.push(run.path.join("."));
        }
        if (calls === 1) {
          throw new Error("first call fails");
        }
        return "ok";
      });
      const holder = workflow(`holder-${String(nested)}`, () => flaky());
      const parent = step(`retrying-${String(nested)}`)
        .config({ retry: { maxAttempts: 2 } })
        .input(z.object({ value: z.string() }))
        .do(({ input }) => input.value);
      const outer = workflow(`retried-${String(nested)}`, () =>
        parent({ value: nested ? holder() : flaky() })
      );
      outcomes.push(
        await engine.execute<string>(outer, {}).then(
          (value) => ({ calls, settled: value }),
          () => ({ calls, settled: "failed" })
        )
      );
    }
    expect(outcomes).toEqual([
      { calls: 2, settled: "ok" },
      { calls: 2, settled: "ok" },
    ]);
    expect(paths.map((path) => path.split(".").slice(1))).toEqual([
      ["value", "$workflow"],
      ["value", "$workflow"],
    ]);
  });

  it("checks a nested workflow's input and output types where it is locked", () => {
    const { plusOne, sum } = incrementing();
    const named = step("named").do(() => "text");
    const words = step("words")
      .input(z.object({ text: z.string() }))
      .do(({ input }) => input.text);
    const typed = workflow("typed")
      .input(z.object({ n: z.number() }))
      .do(({ input }) => plusOne({}, { n: input.n }));
    expect(() => {
      typed({ n: plusOne({}, { n: 1 }) });
      sum({ a: typed({}, { n: 1 }), b: typed({}, { n: 2 }) });
      // @ts-expect-error a string cannot feed a number input
      typed({ n: named() });
      // @ts-expect-error a nested workflow's number output cannot feed a string input
      words({ text: typed({}, { n: 1 }) });
    }).not.toThrow();
  });

  it("rejects $workflow as a declared input child name on a locked workflow, while allowing it as a literal input", async () => {
    const leaf = step("leaf").do(() => "child-value");
    const body = step("body")
      .input(z.object({ label: z.string() }))
      .do(({ input }) => `ran:${input.label}`);
    const inner = workflow("reserved-input")
      .input(z.object({ $workflow: z.string() }))
      .do(({ input }) => body({}, { label: input.$workflow }));
    expect(() => inner({ $workflow: leaf() })).toThrow(RESERVED_WORKFLOW_CHILD);

    const outer = workflow("literal-reserved", () =>
      inner({}, { $workflow: "from-literal" })
    );
    const engine = await engineFor();
    await expect(engine.execute(outer, {})).resolves.toBe("ran:from-literal");
  });
});

describe("a nested workflow's run", () => {
  function parkingTree() {
    const counts = { approve: 0, before: 0, prep: 0, setup: 0 };
    const before = step("before").do(() => {
      counts.before += 1;
      return "ready";
    });
    const prep = step("prep").do(() => {
      counts.prep += 1;
      return "prepared";
    });
    const approve = step("approve")
      .input(z.object({ prepared: z.string(), state: z.string() }))
      .do(async ({ ask, input }) => {
        counts.approve += 1;
        const { approved } = await ask.approval({ title: "Ship it?" });
        return `${input.state} ${input.prepared}: ${approved ? "shipped" : "held"}`;
      });
    const gate = workflow("gate")
      .input(z.object({ state: z.string() }))
      .do(({ input }) => {
        counts.setup += 1;
        return approve({ prepared: prep() }, { state: input.state });
      });
    const report = step("report")
      .input(z.object({ outcome: z.string() }))
      .do(({ input }) => `report ${input.outcome}`);
    workflow("release", () => report({ outcome: gate({ state: before() }) }));
    return counts;
  }

  it("parks on an approval inside a nested workflow and goes on once it is answered", async () => {
    const counts = parkingTree();
    const engine = await engineFor({ askable: true });

    const launched = await engine.launch<string>("release", {});
    const question = await openQuestion(() => engine.feed());
    await engine.answer(question.id, "approve");
    await expect(launched.result).resolves.toBe(
      "report ready prepared: shipped"
    );
    expect(counts.before).toBe(1);
    expect(counts.prep).toBe(1);
  });

  it("is adopted by the next engine while suspended inside a nested workflow, and resumes there", async () => {
    const state = join(root, "state");
    const feedRoot = join(root, "feed");
    let counts = parkingTree();
    const feedOne = openFeed(feedRoot, { id: "ws", root });
    const one = await engineFor({
      artifacts: feedOne.artifacts,
      askable: true,
      state,
    });
    const launched = await one.launch<string>("release", {});
    launched.result.catch(() => undefined);
    const question = await openQuestion(feedOne.read);
    await vi.waitFor(async () =>
      expect(
        (await one.runs()).find((run) => run.id === launched.id)?.status
      ).toBe("suspended")
    );
    await one.dispose();
    expect(counts).toEqual({ approve: 1, before: 1, prep: 1, setup: 1 });

    catalog.reset();
    counts = parkingTree();
    const lines: string[] = [];
    const feedTwo = openFeed(feedRoot, { id: "ws", root });
    const two = await engineFor({
      artifacts: feedTwo.artifacts,
      askable: true,
      print: (line) => lines.push(line),
      state,
    });
    expect(
      (await two.runs()).find((run) => run.id === launched.id)?.status
    ).toBe("suspended");
    await two.answer(question.id, "approve");
    await vi.waitFor(async () => {
      const run = (await two.runs()).find((each) => each.id === launched.id);
      expect(run?.status).toBe("complete");
      expect(run?.output).toBe("report ready prepared: shipped");
    });
    expect(counts).toMatchObject({ approve: 1, before: 0, prep: 0 });
  });

  it("uses saved outputs from sequential synchronous children after restart", async () => {
    const state = join(root, "sequential-state");
    const feedRoot = join(root, "sequential-feed");
    let sourceValue = 7;
    let firstCalls = 0;
    let secondCalls = 0;
    let parentCalls = 0;
    function defineSequence() {
      const first = step("sequence-first").do(() => {
        firstCalls += 1;
        return { value: sourceValue };
      });
      const second = step("sequence-second")
        .input(z.object({ value: z.number() }))
        .do(({ input }) => {
          secondCalls += 1;
          return input.value * 3;
        });
      const sequence = step("sequence-body").do(async ({ ask }) => {
        parentCalls += 1;
        const prior = await first.run();
        const result = await second.run(prior);
        await ask.approval({ title: "Keep saved result?" });
        return { prior, result };
      });
      workflow("sequential-output", () => sequence());
    }
    defineSequence();
    const feedOne = openFeed(feedRoot, { id: "ws", root });
    const one = await engineFor({
      artifacts: feedOne.artifacts,
      askable: true,
      state,
    });
    const launched = await one.launch("sequential-output", {});
    launched.result.catch(() => undefined);
    const question = await openQuestion(feedOne.read);
    await vi.waitFor(async () =>
      expect(
        (await one.runs()).find((run) => run.id === launched.id)?.status
      ).toBe("suspended")
    );
    await one.dispose();
    expect({ firstCalls, parentCalls, secondCalls }).toEqual({
      firstCalls: 1,
      parentCalls: 1,
      secondCalls: 1,
    });

    catalog.reset();
    sourceValue = 99;
    defineSequence();
    const feedTwo = openFeed(feedRoot, { id: "ws", root });
    const two = await engineFor({
      artifacts: feedTwo.artifacts,
      askable: true,
      state,
    });
    await two.answer(question.id, "approve");
    await vi.waitFor(async () => {
      const run = (await two.runs()).find((each) => each.id === launched.id);
      expect(run?.status).toBe("complete");
      expect(run?.output).toEqual({ prior: { value: 7 }, result: 21 });
    });
    expect({ firstCalls, parentCalls, secondCalls }).toEqual({
      firstCalls: 1,
      parentCalls: 2,
      secondCalls: 1,
    });
  });

  it("pauses and resumes through the place a workflow is locked", async () => {
    let attempts = 0;
    const started = Promise.withResolvers<void>();
    const slow = step("slow")
      .input(z.object({ ready: z.string() }))
      .do(
        ({ signal }) =>
          new Promise<string>((resolve, reject) => {
            attempts += 1;
            if (attempts > 1) {
              resolve("again");
              return;
            }
            started.resolve();
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          })
      );
    let prepared = 0;
    const prepare = step("prepare").do(() => {
      prepared += 1;
      return "ready";
    });
    const inner = workflow("inner", () => slow({ ready: prepare() }));
    const shell = step("shell")
      .input(z.object({ value: z.string() }))
      .do(({ input }) => input.value.toUpperCase());
    workflow("paused", () => shell({ value: inner() }));
    const engine = await engineFor();

    const launched = await engine.launch<string>("paused", {});
    await started.promise;
    expect(engine.pause(launched.id, "paused.value", "hold")).toBe(true);
    await vi.waitFor(async () =>
      expect(
        (await engine.runs()).find((run) => run.id === launched.id)?.status
      ).toBe("suspended")
    );
    await engine.resume(launched.id, "paused.value");
    await expect(launched.result).resolves.toBe("AGAIN");
    expect(attempts).toBe(2);
    expect(prepared).toBe(1);
  });

  it("cancels the steps of a nested workflow with its run", async () => {
    const started = Promise.withResolvers<void>();
    let aborted = false;
    const hang = step("hang").do(
      ({ signal }) =>
        new Promise<string>((_resolve, reject) => {
          started.resolve();
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true }
          );
        })
    );
    const inner = workflow("hanging", () => hang());
    const shell = step("hang-shell")
      .input(z.object({ value: z.string() }))
      .do(({ input }) => input.value);
    workflow("cancelled-outer", () => shell({ value: inner() }));
    const engine = await engineFor();

    const launched = await engine.launch<string>("cancelled-outer", {});
    await started.promise;
    await engine.cancel(launched.id);
    await expect(launched.result).rejects.toThrow(CANCELLED);
    expect(aborted).toBe(true);
  });

  it("stops a nested workflow when a sibling under .parallel fails", async () => {
    const started = Promise.withResolvers<void>();
    let aborted = false;
    const hang = step("sibling-hang").do(
      ({ signal }) =>
        new Promise<string>((_resolve, reject) => {
          started.resolve();
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true }
          );
        })
    );
    const inner = workflow("sibling-hanging", () => hang());
    const failing = step("failing").do(async (): Promise<string> => {
      await started.promise;
      throw new Error("broke");
    });
    const both = step("both")
      .input(z.object({ a: z.string(), b: z.string() }))
      .do(({ input }) => input.a + input.b);
    const outer = workflow("failing-parallel", () =>
      both.parallel({ a: inner(), b: failing() })
    );
    const engine = await engineFor();

    await expect(engine.execute(outer, {})).rejects.toThrow(BROKE);
    expect(aborted).toBe(true);
  });
});

it("resumes an explicit suspension inside a nested workflow after restart", async () => {
  const state = join(root, "pause-restart");
  let calls = 0;
  let started = Promise.withResolvers<void>();
  const declare = () => {
    const work = step("restart-work").do(({ signal }) => {
      calls += 1;
      if (calls > 1) {
        return "resumed";
      }
      started.resolve();
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    });
    const inner = workflow("restart-inner", () => work());
    const output = step("restart-output")
      .input(z.object({ value: z.string() }))
      .do(({ input }) => input.value);
    workflow("restart-outer", () => output({ value: inner() }));
  };
  declare();
  const first = await engineFor({ state });
  const launched = await first.launch("restart-outer", {});
  launched.result.catch(() => undefined);
  await started.promise;
  expect(first.pause(launched.id, "restart-outer.value", "hold")).toBe(true);
  await vi.waitFor(async () => {
    expect(
      (await first.runs()).find((run) => run.id === launched.id)?.status
    ).toBe("suspended");
  });
  await first.dispose();
  catalog.reset();
  started = Promise.withResolvers<void>();
  declare();
  const second = await engineFor({ state });
  await second.resume(launched.id, "restart-outer.value");
  await vi.waitFor(async () => {
    expect(
      (await second.runs()).find((run) => run.id === launched.id)
    ).toMatchObject({ output: "resumed", status: "complete" });
  });
});
