import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySessionStore } from "@foundry/agents/store/memory";
import { thisProcess } from "@foundry/lib/node/process-identity";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { step } from "~/authoring/builder";
import { catalog } from "~/authoring/catalog";
import { agent } from "~/authoring/resources";
import type { Engine } from "~/lib/engine";
import { bindMock } from "../helpers/bindings";
import { startEngine } from "../helpers/engine";
import { openFeed } from "../helpers/feed";
import { storedRun } from "../helpers/stored-runs";

let root: string;
const engines: Engine[] = [];
const ACROSS = { timeout: 10_000 };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marbles-hand-over-"));
});

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  catalog.reset();
  await rm(root, { force: true, recursive: true });
});

function generation(
  options: Parameters<typeof startEngine>[0] = {}
): Promise<{ readonly engine: Engine; readonly lines: string[] }> {
  const lines: string[] = [];
  return startEngine({
    artifacts: openFeed(join(root, "feed"), { id: "ws", root }).artifacts,
    askable: true,
    print: (line) => lines.push(line),
    root,
    state: join(root, "state"),
    ...options,
  }).then((engine) => {
    engines.push(engine);
    return { engine, lines };
  });
}

it("a retiring engine finishes its running run untouched, and the next engine answers its suspended run and finishes it", async () => {
  const state = join(root, "state");
  const linger = Promise.withResolvers<void>();
  let lingered = 0;
  step("release").do(
    async ({ ask }) => (await ask.approval({ title: "Ship?" })).approved
  );
  step("linger").do(async () => {
    lingered += 1;
    await linger.promise;
    return "lingered";
  });
  const old = await generation();
  const suspended = await old.engine.launch<boolean>("release", {});
  suspended.result.catch(() => undefined);
  const running = await old.engine.launch<string>("linger", {});
  await vi.waitFor(
    async () =>
      expect((await storedRun(state, suspended.id))?.status).toBe("suspended"),
    ACROSS
  );
  const next = await generation();
  const { ended } = await old.engine.retire(thisProcess());

  const question = (await next.engine.feed()).find(
    (entry) => entry.input?.status === "open"
  );
  if (!question) {
    throw new Error("expected the question to stay open");
  }
  await next.engine.answer(question.id, "approve");
  await vi.waitFor(
    async () =>
      expect((await storedRun(state, suspended.id))?.status).toBe("complete"),
    ACROSS
  );
  expect(next.lines).toContain(`[run] release taken up ${suspended.id}`);
  expect(old.lines.join("\n")).not.toContain("taken up");
  expect((await storedRun(state, running.id))?.status).toBe("running");

  linger.resolve();
  await expect(running.result).resolves.toBe("lingered");
  await ended;
  expect(lingered).toBe(1);
  await vi.waitFor(
    () =>
      expect(next.engine.executions.get(suspended.id)?.status).toBe("complete"),
    ACROSS
  );
});

it("a run paused on a retiring engine, resumed there, runs on the next one with the prompt it was resumed with", async () => {
  const state = join(root, "state");
  const sessions = new InMemorySessionStore();
  const prompts: string[] = [];
  const reply = ({ prompt }: { readonly prompt: string }) => {
    prompts.push(prompt);
    return "ok";
  };
  const reviewer = agent({ prompt: "Review." });
  const sessionIds: string[] = [];
  step("review").do(async ({ agents, signal }) => {
    const session = await agents.session(reviewer);
    sessionIds.push(session.ref.id);
    const answer = await session.generate("look at the tests");
    if (sessionIds.length === 1) {
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true })
      );
    }
    return answer.text;
  });
  const first = bindMock(reply, { root, sessions });
  const old = await generation(first.instances);
  const launched = await old.engine.launch<string>("review", {});
  launched.result.catch(() => undefined);
  await vi.waitFor(() => expect(prompts).toHaveLength(1));
  expect(old.engine.pause(launched.id, "review", "hold")).toBe(true);
  await vi.waitFor(
    async () =>
      expect((await storedRun(state, launched.id))?.status).toBe("suspended"),
    ACROSS
  );
  const second = bindMock(reply, { root, sessions });
  const next = await generation(second.instances);
  await (await old.engine.retire(thisProcess())).ended;

  await old.engine.resume(launched.id, "review", "focus on flaky ones");
  expect(old.engine.executions.get(launched.id)?.status).not.toBe("running");
  await vi.waitFor(
    async () =>
      expect((await storedRun(state, launched.id))?.status).toBe("complete"),
    ACROSS
  );
  expect(next.lines).toContain(`[run] review taken up ${launched.id}`);
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("focus on flaky ones\n\nlook at the tests");
  expect(sessionIds).toHaveLength(2);
  expect(sessionIds[1]).toBe(sessionIds[0]);
  await first.dispose();
  await second.dispose();
});

it("cancels a suspended run, and closes its question, from an engine that never ran it", async () => {
  const state = join(root, "state");
  step("release").do(
    async ({ ask }) => (await ask.approval({ title: "Ship?" })).approved
  );
  const old = await generation();
  const launched = await old.engine.launch<boolean>("release", {});
  const outcome = launched.result.catch((error: unknown) => error);
  await vi.waitFor(
    async () =>
      expect((await storedRun(state, launched.id))?.status).toBe("suspended"),
    ACROSS
  );
  const next = await generation();

  const question = (await next.engine.feed()).find(
    (entry) => entry.input?.status === "open"
  );
  await next.engine.cancel(launched.id);
  await vi.waitFor(
    async () =>
      expect((await storedRun(state, launched.id))?.status).toBe("cancelled"),
    ACROSS
  );
  expect(
    (await next.engine.feed()).find((entry) => entry.id === question?.id)?.input
      ?.status
  ).toBe("cancelled");
  expect(await outcome).toBeInstanceOf(Error);
  await vi.waitFor(
    () =>
      expect(old.engine.executions.get(launched.id)?.status).toBe("cancelled"),
    ACROSS
  );
});
