/**
 * Definitions you can use: an agent generates and streams on its own, and
 * a step or workflow runs on its own. Inside a body the call joins the
 * body's run; outside one it uses the host's engine, else a default.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { step, workflow } from "~/authoring/builder";
import { catalog } from "~/authoring/catalog";
import { agent } from "~/authoring/resources";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import type { Reply } from "~/lib/models/echo";
import { dispose, setDefaultRuntime, setHost } from "~/lib/runtime";
import { startEngine, testEngine } from "../helpers/engine";
import { openFeed } from "../helpers/feed";

const ASKED_PATTERN = /asked a person/;

let root: string;
const engines: { dispose(): Promise<void> }[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marbles-instances-"));
});

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  await dispose();
  catalog.reset();
  await rm(root, { force: true, recursive: true });
});

/** An engine over mock models that answers with `reply`, as the host. */
function host(reply: Reply = ({ prompt }) => prompt) {
  const engine = testEngine({ print: () => undefined, reply, root });
  engines.push(engine);
  setHost(engine);
  return engine;
}

async function openEntry(
  read: () => Promise<FeedEntrySnapshot[]>,
  predicate: (entry: FeedEntrySnapshot) => boolean
) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const entry = (await read()).find(predicate);
    if (entry || Date.now() > deadline) {
      return entry;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("an agent", () => {
  it("generates on the host's engine outside a run", async () => {
    host(() => "from the host");
    const designer = agent({ name: "designer", prompt: "Design." });
    const reply = await designer.generate("Sketch a logo.");
    expect(reply.text).toBe("from the host");
    expect(reply.usage.totalTokens).toBeGreaterThan(0);
  });

  it("uses a default runtime with no host", async () => {
    setDefaultRuntime(() => {
      const engine = testEngine({
        print: () => undefined,
        reply: () => "default",
        root,
      });
      return Promise.resolve(engine);
    });
    const designer = agent({ name: "designer", prompt: "Design." });
    expect((await designer.generate("Sketch.")).text).toBe("default");
  });

  it("streams at once, before the runtime is there", async () => {
    host(() => "streamed");
    const designer = agent({ name: "designer", prompt: "Design." });
    const turn = designer.stream("Sketch.");
    const events: string[] = [];
    for await (const event of turn) {
      events.push(event.type);
    }
    expect(await turn.text).toBe("streamed");
    expect(events.at(-1)).toBe("finish");
  });

  it("spreads to a plain definition that agents.session takes", async () => {
    const engine = host(() => "ok");
    const designer = agent({ name: "designer", prompt: "Design." });
    const copy = { ...designer };
    expect(Object.keys(copy)).not.toContain("generate");
    const session = await engine.agents.session(copy);
    expect((await session.generate("Sketch.")).text).toBe("ok");
  });

  it("in a body, is one turn that a replay returns without running it again", async () => {
    const prompts: string[] = [];
    const designer = agent({ name: "designer", prompt: "Design." });
    const reviewer = agent({ name: "reviewer", prompt: "Review." });
    const sessions: string[] = [];
    step("sketch").do(async ({ agents, ask }) => {
      const { text } = await designer.generate("Sketch a logo.");
      // Opened after the agent's own turn: its place in the ledger must not
      // move when that turn is replayed instead of run.
      const session = await agents.session(reviewer);
      sessions.push(session.ref.id);
      await ask.approval({ title: "Keep it?" });
      return text;
    });
    const store = openFeed(undefined, { id: "ws", root });
    const engine = await startEngine({
      artifacts: store.artifacts,
      askable: true,
      print: () => undefined,
      reply: ({ prompt }) => {
        prompts.push(prompt);
        return "a logo";
      },
      root,
    });
    engines.push(engine);
    const launched = await engine.launch<string>("sketch", {});
    const question = await openEntry(
      store.read,
      (entry) => entry.input?.status === "open"
    );
    if (!question) {
      throw new Error("expected an open approval");
    }
    await engine.answer(question.id, { choice: "approve" });
    await expect(launched.result).resolves.toBe("a logo");
    expect(
      prompts.filter((prompt) => prompt.includes("Sketch a logo."))
    ).toHaveLength(1);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toBe(sessions[1]);
    await engine.stop();
  });
});

describe("a step or workflow", () => {
  it("runs a nameless step on the host's engine", async () => {
    host();
    const double = step()
      .input(z.object({ n: z.number() }))
      .do(({ input }) => input.n * 2);
    await expect(double.run({ n: 2 })).resolves.toBe(4);
  });

  it("runs a workflow's tree", async () => {
    host();
    const one = step("one").do(() => 1);
    const sum = step("sum")
      .input(z.object({ a: z.number(), b: z.number() }))
      .do(({ input }) => input.a + input.b);
    const pair = workflow("pair", sum({ a: one({}), b: one({}) }));
    await expect(pair.run()).resolves.toBe(2);
  });

  it("in a body, joins the run and is replayed from the ledger", async () => {
    let inner = 0;
    const count = step("count").do(() => {
      inner += 1;
      return "counted";
    });
    step("outer").do(async ({ ask }) => {
      const value = await count.run();
      await ask.approval({ title: "Go on?" });
      return value;
    });
    const store = openFeed(undefined, { id: "ws", root });
    const engine = await startEngine({
      artifacts: store.artifacts,
      askable: true,
      print: () => undefined,
      root,
    });
    engines.push(engine);
    const launched = await engine.launch<string>("outer", {});
    const question = await openEntry(
      store.read,
      (entry) => entry.input?.status === "open"
    );
    if (!question) {
      throw new Error("expected an open approval");
    }
    await engine.answer(question.id, { choice: "approve" });
    await expect(launched.result).resolves.toBe("counted");
    expect(inner).toBe(1);
    await engine.stop();
  });

  it("says when a step asked a person with no one to answer", async () => {
    host();
    const asks = step().do(({ ask }) => ask.question({ title: "Name?" }));
    await expect(asks.run()).rejects.toThrow(ASKED_PATTERN);
  });
});
