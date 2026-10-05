/**
 * Spike: the mechanics the new tree materialization rests on, checked on
 * the raw workflows package with no Marbles code. A parent declares its
 * children on the spec and drives them from its own body with `child.run()`.
 */

import type { ChannelMessage } from "@foundry/workflows/channels";
import type { StepContext } from "@foundry/workflows/step";
import { Step } from "@foundry/workflows/step";
import { Workflow } from "@foundry/workflows/workflow";
import { describe, expect, it } from "vitest";

type Body<O> = (ctx: StepContext<unknown, O>) => Promise<O>;

function leaf<O>(name: string, body: Body<O>) {
  return Step.create<unknown, O>({
    execute: (_input, ctx) => body(ctx),
    input: {},
    name,
  });
}

function series(name: string, children: Step[]) {
  return Step.create<unknown, Record<string, unknown>>({
    children,
    execute: async (_input, ctx) => {
      const results: Record<string, unknown> = {};
      for (const child of ctx.children) {
        results[child.name] = await child.run();
      }
      return results;
    },
    input: {},
    name,
  });
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

describe("spike: children driven from the parent body", () => {
  it("gives children the real path and tags their chunks with it", async () => {
    const paths: string[][] = [];
    const a = leaf("a", async (ctx) => {
      paths.push([...ctx.path]);
      ctx.write("from-a");
      return "A";
    });
    const b = leaf("b", async (ctx) => {
      paths.push([...ctx.path]);
      ctx.write("from-b");
      return "B";
    });
    const root = series("root", [a, b]);
    const wf = Workflow.attach(root, {});
    const controller = new AbortController();
    const messages = collect(root.subscribe(controller.signal));

    const result = await wf.run();
    controller.abort();

    expect(result).toEqual({ a: "A", b: "B" });
    expect(paths).toEqual([
      ["root", "a"],
      ["root", "b"],
    ]);
    const chunks = (await messages).flatMap((message) =>
      message._tag === "chunk" && message.chunk.payload.kind === "text"
        ? [`${message.chunk.path.join(".")}:${message.chunk.payload.text}`]
        : []
    );
    expect(chunks).toEqual(["root.a:from-a", "root.b:from-b"]);
    expect(Object.keys(wf.state.steps).sort()).toEqual([
      "root",
      "root.a",
      "root.b",
    ]);
  });

  it("series: a finished sibling is not re-run after a suspension resumes", async () => {
    const ran: string[] = [];
    const a = leaf("a", async () => {
      ran.push("a");
      return "A";
    });
    const b = leaf("b", async (ctx) => {
      ran.push("b");
      const answer = await ctx.suspend<string>({ name: "q", reason: "ask" });
      return answer;
    });
    const root = Step.create<unknown, Record<string, unknown>>({
      children: [a, b],
      execute: async (_input, ctx) => {
        ran.push("root");
        const results: Record<string, unknown> = {};
        for (const child of ctx.children) {
          results[child.name] = await child.run();
        }
        return results;
      },
      input: {},
      name: "root",
    });
    const wf = Workflow.attach(root, {});

    await wf.run().catch(() => undefined);
    expect(wf.status).toBe("suspended");
    expect(ran).toEqual(["root", "a", "b"]);

    await wf.resume("q", "yes");
    const result = await wf.run();

    expect(wf.status).toBe("complete");
    expect(result).toEqual({ a: "A", b: "yes" });
    // root replays, a is skipped (recorded output), b replays and completes.
    expect(ran).toEqual(["root", "a", "b", "root", "b"]);
  });

  it("parallel: a suspension parks the run and finished siblings skip on resume", async () => {
    const ran: string[] = [];
    let settleA: Promise<unknown> | undefined;
    const a = leaf("a", async () => {
      ran.push("a");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "A";
    });
    const b = leaf("b", async (ctx) => {
      ran.push("b");
      return await ctx.suspend<string>({ name: "q", reason: "ask" });
    });
    const root = Step.create<unknown, Record<string, unknown>>({
      children: [a, b],
      execute: async (_input, ctx) => {
        ran.push("root");
        const runs = ctx.children.map((child) =>
          child.run().then(
            (value) => ({ name: child.name, value }),
            (error: unknown) => {
              throw error;
            }
          )
        );
        settleA ??= Promise.allSettled(runs);
        const values = await Promise.all(runs);
        return Object.fromEntries(values.map((v) => [v.name, v.value]));
      },
      input: {},
      name: "root",
    });
    const wf = Workflow.attach(root, {});

    await wf.run().catch(() => undefined);
    expect(wf.status).toBe("suspended");
    await settleA;

    await wf.resume("q", "yes");
    const result = await wf.run();

    expect(wf.status).toBe("complete");
    expect(result).toEqual({ a: "A", b: "yes" });
    expect(ran).toEqual(["root", "a", "b", "root", "b"]);
  });
});
