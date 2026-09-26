/**
 * The tree contract on real package Steps: parent last with merged input,
 * siblings independent, validation at the seams, suspension replay with
 * finished children skipped, reports and asks identified by position,
 * and cancellation reaching bodies.
 */

import type { ChannelMessage } from "@foundry/workflows/channels";
import { Workflow } from "@foundry/workflows/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Bindings } from "~/lib/bindings";
import { unbound } from "~/lib/bindings";
import { step, workflow } from "~/lib/builder";
import { catalog } from "~/lib/catalog";
import type { AnyDefinition } from "~/lib/definition";
import { createLog } from "~/lib/log";
import { runs } from "~/lib/run-scope";
import { factoryFor } from "~/lib/tree";

const TYPED_INPUT = /"typed" input: n/;
const TYPED_OUTPUT = /"typed" output/;
const ONLY_NAMED = /only named definitions/;

const lines: string[] = [];

const bindings: Bindings = {
  agents: () => unbound("agents"),
  artifacts: () => unbound("artifacts"),
  log: createLog((_level, message) => lines.push(message)),
  root: process.cwd(),
  sandboxes: () => unbound("sandboxes"),
  workspaces: () => unbound("workspaces"),
};

afterEach(() => {
  catalog.reset();
  lines.length = 0;
  runs.clear();
});

async function launch(definition: AnyDefinition, input: unknown = {}) {
  const root = await factoryFor(definition, () => bindings)(input, undefined);
  const wf = Workflow.attach(root, input);
  return { root, wf };
}

async function collect(
  stream: ReadableStream<ChannelMessage>
): Promise<ChannelMessage[]> {
  const items: ChannelMessage[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return items;
    }
    items.push(value);
  }
}

describe("trees", () => {
  it("runs children first and hands the parent their results merged with literals", async () => {
    const order: string[] = [];
    const review = step()
      .input(z.object({ target: z.string().default(".") }))
      .output(z.string())
      .do(({ input }) => {
        order.push(`review:${input.target}`);
        return `reviewed ${input.target}`;
      });
    const test = step().do(() => {
      order.push("test");
      return 0;
    });
    const publish = step()
      .input(
        z.object({
          exitCode: z.number(),
          findings: z.string(),
          title: z.string(),
        })
      )
      .do(({ input }) => {
        order.push("publish");
        return `${input.title}: ${input.findings} (${input.exitCode})`;
      });
    const weekly = workflow(
      "weekly",
      publish.parallel(
        { exitCode: test({}), findings: review({}, { target: "docs" }) },
        { title: "Weekly" }
      )
    );

    const { wf } = await launch(weekly);
    await expect(wf.run()).resolves.toBe("Weekly: reviewed docs (0)");
    expect(order.slice(-1)).toEqual(["publish"]);
    expect(order).toHaveLength(3);
    expect(Object.keys(wf.state.steps).sort()).toEqual([
      "weekly",
      "weekly.exitCode",
      "weekly.findings",
    ]);
  });

  it("series runs children in key order; parallel runs them together", async () => {
    const seen: string[] = [];
    const slow = step().do(async () => {
      seen.push("slow:start");
      await new Promise((resolve) => setTimeout(resolve, 15));
      seen.push("slow:end");
      return 1;
    });
    const fast = step().do(() => {
      seen.push("fast");
      return 2;
    });
    const sum = step()
      .input(z.object({ a: z.number(), b: z.number() }))
      .do(({ input }) => input.a + input.b);

    const inSeries = workflow("series", sum({ a: slow({}), b: fast({}) }));
    await expect((await launch(inSeries)).wf.run()).resolves.toBe(3);
    expect(seen).toEqual(["slow:start", "slow:end", "fast"]);

    seen.length = 0;
    const together = workflow(
      "parallel",
      sum.parallel({ a: slow({}), b: fast({}) })
    );
    await expect((await launch(together)).wf.run()).resolves.toBe(3);
    expect(seen).toEqual(["slow:start", "fast", "slow:end"]);
  });

  it("validates launch input, merged input, and output", async () => {
    const typed = step("typed")
      .input(z.object({ n: z.number() }))
      .output(z.string())
      .do(({ input }) => (input.n > 0 ? "ok" : (42 as unknown as string)));

    await expect(
      factoryFor(typed, () => bindings)({ n: "x" }, undefined)
    ).rejects.toThrow(TYPED_INPUT);

    await expect((await launch(typed, { n: 1 })).wf.run()).resolves.toBe("ok");
    await expect((await launch(typed, { n: 0 })).wf.run()).rejects.toThrow(
      TYPED_OUTPUT
    );
  });

  it("a workflow's setup runs each time and returns the tree", async () => {
    let setups = 0;
    const echo = step()
      .input(z.object({ task: z.string() }))
      .do(({ input }) => input.task.toUpperCase());
    const ship = workflow("ship")
      .input(z.object({ task: z.string() }))
      .do(({ input }) => {
        setups += 1;
        return echo({}, { task: input.task });
      });
    const first = await launch(ship, { task: "a" });
    await expect(first.wf.run()).resolves.toBe("A");
    const second = await launch(ship, { task: "b" });
    await expect(second.wf.run()).resolves.toBe("B");
    expect(setups).toBe(2);
  });

  it("a finished child is skipped when a suspended sibling resumes", async () => {
    const ran: string[] = [];
    const gather = step().do(() => {
      ran.push("gather");
      return "notes";
    });
    const approve = step()
      .input(z.object({ notes: z.string() }))
      .do(async ({ ask, input }) => {
        ran.push("approve");
        const { approved } = await ask.approval({
          body: input.notes,
          title: "Ship it?",
        });
        return approved;
      });
    const flow = workflow("flow", approve({ notes: gather({}) }));
    const { wf } = await launch(flow);

    await wf.run().catch(() => undefined);
    expect(wf.status).toBe("suspended");
    expect(ran).toEqual(["gather", "approve"]);

    await wf.resume("quirks.ask#0", "approve");
    await expect(wf.run()).resolves.toBe(true);
    expect(ran).toEqual(["gather", "approve", "approve"]);
  });

  it("identifies asks and reports by their position in the body", async () => {
    const twice = step("twice").do(async ({ ask, report }) => {
      report.milestone({ title: "start" });
      const first = await ask.question({ title: "first?" });
      const second = await ask.question({
        choices: ["a", "b"],
        title: "second?",
      });
      report.result({ body: "done", key: "final", title: "end" });
      return `${first}/${second}`;
    });
    const { root, wf } = await launch(twice);
    const controller = new AbortController();
    const messages = collect(root.subscribe(controller.signal));

    await wf.run().catch(() => undefined);
    await wf.resume("quirks.ask#0", "one");
    await wf.run().catch(() => undefined);
    expect(wf.status).toBe("suspended");
    await wf.resume("quirks.ask#1", "b");
    await expect(wf.run()).resolves.toBe("one/b");
    controller.abort();

    const events = await messages;
    const suspensions = events.flatMap((message) =>
      message._tag === "event" && message.event._tag === "step.suspended"
        ? [message.event.suspension]
        : []
    );
    expect(suspensions.map((s) => [s.name, s.occurrence, s.request])).toEqual([
      [
        "quirks.ask#0",
        0,
        {
          body: "",
          choices: [],
          key: "ask:0",
          mode: "question",
          title: "first?",
        },
      ],
      [
        "quirks.ask#1",
        0,
        {
          body: "",
          choices: ["a", "b"],
          key: "ask:1",
          mode: "question",
          title: "second?",
        },
      ],
    ]);
    const posts = events.flatMap((message) =>
      message._tag === "event" &&
      message.event._tag === "custom" &&
      message.event.type === "quirks.feed.post"
        ? [message.event.payload as { key: string; kind: string }]
        : []
    );
    // The milestone repeats on each replay (three attempts); the keyed result posts once.
    expect(posts.map((post) => `${post.kind}:${post.key}`)).toEqual([
      "milestone:milestone:0",
      "milestone:milestone:0",
      "milestone:milestone:0",
      "result:final",
    ]);
  });

  it("stream.write tags chunks with the step path and log reaches the host", async () => {
    const talk = step()
      .input(z.object({ who: z.string() }))
      .do(({ input, log, stream }) => {
        stream.write(`hi ${input.who}`);
        log("logged", input.who);
        return input.who;
      });
    const join = step()
      .input(z.object({ a: z.string(), b: z.string() }))
      .do(({ input }) => `${input.a}+${input.b}`);
    const flow = workflow(
      "chat",
      join({ a: talk({}, { who: "x" }), b: talk({}, { who: "y" }) })
    );
    const { root, wf } = await launch(flow);
    const controller = new AbortController();
    const messages = collect(root.subscribe(controller.signal));
    await expect(wf.run()).resolves.toBe("x+y");
    controller.abort();
    const chunks = (await messages).flatMap((message) =>
      message._tag === "chunk" && message.chunk.payload.kind === "text"
        ? [`${message.chunk.path.join(".")}:${message.chunk.payload.text}`]
        : []
    );
    expect(chunks).toEqual(["chat.a:hi x", "chat.b:hi y"]);
    expect(lines).toEqual(["logged x", "logged y"]);
  });

  it("run.abort fails the run and aborts every frame's signal", async () => {
    const seen: boolean[] = [];
    const hang = step().do(
      ({ signal }) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            seen.push(signal.aborted);
            reject(signal.reason);
          });
        })
    );
    const bail = step().do(({ run }) => {
      run.abort(new Error("unrecoverable"));
      return "never";
    });
    const both = step()
      .input(z.object({ a: z.string(), b: z.string() }))
      .do(({ input }) => input);
    const flow = workflow("abort", both.parallel({ a: hang({}), b: bail({}) }));
    const { wf } = await launch(flow);
    await expect(wf.run()).rejects.toThrow("unrecoverable");
    expect(wf.status).toBe("failed");
    expect(seen).toEqual([true]);
    expect(runs.size).toBe(1);
  });

  it("exposes the run scope with id, path, and a stable session reference", async () => {
    let observed:
      | { id: string; path: readonly string[]; session: string }
      | undefined;
    const peek = step("peek").do(({ run }) => {
      observed = { id: run.id, path: run.path, session: run.session.id };
      return run.session.id;
    });
    const { wf } = await launch(peek);
    const result = await wf.run();
    expect(observed?.path).toEqual(["peek"]);
    expect(observed?.session).toBe(result);
    expect(runs.get(observed?.id ?? "")).toBeDefined();
  });

  it("a failing parallel sibling aborts the others, and the run fails only once they have stopped", async () => {
    const seen: string[] = [];
    const hang = step().do(async ({ signal }) => {
      // Ignores its signal for a moment: the run must not read as failed
      // while this is still going.
      await new Promise((resolve) => setTimeout(resolve, 30));
      seen.push(signal.aborted ? "stopped after the abort" : "ran");
      return "late";
    });
    const bail = step().do((): string => {
      throw new Error("boom");
    });
    const both = step()
      .input(z.object({ a: z.string(), b: z.string() }))
      .do(({ input }) => input);
    const flow = workflow("fails", both.parallel({ a: hang({}), b: bail({}) }));
    const { wf } = await launch(flow);
    await expect(wf.run()).rejects.toThrow("boom");
    // The sibling had finished before the failure was reported.
    expect(seen).toEqual(["stopped after the abort"]);
    expect(wf.status).toBe("failed");
    expect(
      Object.entries(wf.state.steps)
        .map(([key, state]) => [key, state.status])
        .sort()
    ).toEqual([
      ["fails", "failed"],
      ["fails.a", "failed"],
      ["fails.b", "failed"],
    ]);
  });

  it("a rejected launch registers no run scope", async () => {
    const typed = step("typed")
      .input(z.object({ n: z.number() }))
      .do(({ input }) => input.n);
    await expect(
      factoryFor(typed, () => bindings)({ n: "x" }, undefined)
    ).rejects.toThrow(TYPED_INPUT);
    const broken = workflow("broken").do(() => {
      throw new Error("no tree today");
    });
    await expect(
      factoryFor(broken, () => bindings)({}, undefined)
    ).rejects.toThrow("no tree today");
    expect(runs.size).toBe(0);
  });

  it("parses launch input once, so a transform sees the raw value", async () => {
    const coerce = step("coerce")
      .input(z.object({ n: z.string().transform(Number) }))
      .do(({ input }) => ({ n: input.n, type: typeof input.n }));
    await expect((await launch(coerce, { n: "2" })).wf.run()).resolves.toEqual({
      n: 2,
      type: "number",
    });
  });

  it("refuses to launch an anonymous definition", () => {
    const anonymous = step().do(() => 1);
    expect(() => factoryFor(anonymous, () => bindings)).toThrow(ONLY_NAMED);
  });
});
