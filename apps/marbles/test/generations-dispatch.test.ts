import { join } from "node:path";
import { MemorySessionStore } from "@foundry/agents/store/memory";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { Catalog } from "~/authoring/catalog";
import { GenerationRecords } from "~/database/generations";
import { readLiveGenerations } from "~/database/open";
import type { Engine } from "~/lib/engine";
import { CODEX } from "~/lib/harnesses";
import type { DispatchInfo, DispatchOptions } from "~/model/connection";
import { BackgroundRuns } from "~/workspace/background-runs";
import { type TestEngineOptions, testEngine } from "./helpers/engine";
import {
  gone,
  openGate,
  switchFrom,
  switchingWorkspace,
  whenLogged,
} from "./helpers/generation-switch";

const AGENT_DISPATCH = "agent-dispatch";

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) {
    await engine.dispose();
  }
});

async function host(options: TestEngineOptions) {
  const engine = testEngine({
    pools: { default: { limit: 1 } },
    ...options,
  });
  engines.push(engine);
  const catalog = new Catalog();
  catalog.agents.set("helper", {
    id: "helper",
    kind: "agent",
    prompt: "Help with tasks.",
  });
  engine.define({
    fn: ({ input }: { readonly input: { readonly n: number } }) => input.n + 1,
    kind: "step",
    name: "next",
  });
  const jobs = new BackgroundRuns(engine, catalog);
  await engine.start();
  return { engine, jobs };
}

async function twoGenerations() {
  const sessions = new MemorySessionStore();
  const reply: TestEngineOptions["reply"] = ({ executor, prompt }) =>
    `${executor.provider}|${prompt}`;
  const old = await host({
    hold: ({ prompt }) => prompt.includes("Block the queue"),
    reply,
    sessions,
  });
  const next = await host({
    hold: ({ prompt }) => prompt.includes("Hold here"),
    reply,
    sessions,
  });
  await old.jobs.start({ prompt: "Block the queue" });
  return { next, old };
}

async function queuedInput(
  engine: Engine,
  started: DispatchInfo
): Promise<Record<string, unknown>> {
  expect(started.status).toBe("queued");
  const input = engine.executions.get(started.runId)?.input;
  expect(input).toBeDefined();
  return input as Record<string, unknown>;
}

async function movedTurn(
  options: DispatchOptions,
  reshape: (input: Record<string, unknown>) => Record<string, unknown> = (
    input
  ) => input
) {
  const { next, old } = await twoGenerations();
  const started = await old.jobs.start(options);
  const input = reshape(await queuedInput(old.engine, started));
  const launched = await next.engine.launch<{ readonly text: string }>(
    AGENT_DISPATCH,
    input
  );
  launched.result.catch(() => undefined);
  return { launched, next, old, started };
}

describe("a queued agent dispatch taken by another generation", () => {
  it("runs a declared agent's turn on the session the first generation opened", async () => {
    const { launched, started } = await movedTurn({
      agent: "helper",
      instructions: "Answer briefly.",
      prompt: "Carry on",
    });
    const { text } = await launched.result;
    expect(text).toContain("Help with tasks.");
    expect(text).toContain("Answer briefly.");
    expect(text).toContain("Carry on");
    expect(started.session?.id).toBeTruthy();
  });

  it("runs an undeclared agent's turn with its route and instructions", async () => {
    const { launched, next, started } = await movedTurn({
      instructions: "Inspect only.",
      model: CODEX.model,
      prompt: "Carry on",
      provider: CODEX.provider,
    });
    const { text } = await launched.result;
    expect(text).toContain("codex|");
    expect(text).toContain("Inspect only.");
    expect(text).toContain("Carry on");
    const read = await next.jobs.get(launched.id);
    expect(read.name).toBe(started.name);
    expect(read.session?.id).toBe(started.session?.id);
  });

  it("continues a session an earlier dispatch left", async () => {
    const sessions = new MemorySessionStore();
    const first = await host({ sessions });
    const before = await first.jobs.start({
      agent: "helper",
      prompt: "Remember this",
    });
    await vi.waitFor(async () =>
      expect((await first.jobs.get(before.runId)).status).toBe("completed")
    );
    const old = await host({ hold: () => true, sessions });
    const next = await host({ sessions });
    await old.jobs.start({ prompt: "Block the queue" });
    const started = await old.jobs.start({
      agent: "helper",
      prompt: "Continue",
      ...(before.session ? { session: before.session } : {}),
    });
    const launched = await next.engine.launch<{ readonly text: string }>(
      AGENT_DISPATCH,
      await queuedInput(old.engine, started)
    );
    const { text } = await launched.result;
    expect(text).toContain("Remember this");
    expect(text).toContain("Continue");
    expect((await next.jobs.get(launched.id)).session?.id).toBe(
      before.session?.id
    );
  });

  it("runs a turn queued before the agent id travelled with the run", async () => {
    const { launched, next } = await movedTurn(
      { agent: "helper", prompt: "Carry on" },
      ({ agentId: _dropped, ...kept }) => kept
    );
    expect((await launched.result).text).toContain("Carry on");
    expect((await next.jobs.get(launched.id)).name).toBe("helper");
  });

  it("refuses a second dispatch on the session while the taken turn runs", async () => {
    const { launched, next, started } = await movedTurn({
      agent: "helper",
      prompt: "Hold here",
    });
    await vi.waitFor(async () =>
      expect((await next.jobs.get(launched.id)).status).toBe("running")
    );
    await expect(
      next.jobs.start({
        agent: "helper",
        prompt: "Again",
        ...(started.session ? { session: started.session } : {}),
      })
    ).rejects.toThrow("active agent dispatch");
    await next.jobs.cancel(launched.id);
  });
});

describe("a run this host did not start but its engine owns", () => {
  it("reads an agent run: kind, name, session, and its text once settled", async () => {
    const { launched, next, started } = await movedTurn({
      agent: "helper",
      prompt: "Carry on",
    });
    await launched.result;
    const read = await next.jobs.get(launched.id);
    expect(read).toMatchObject({
      kind: "agent",
      name: "helper",
      runId: launched.id,
      status: "completed",
    });
    expect(read.session?.id).toBe(started.session?.id);
    expect(read.text).toContain("Carry on");
    expect(read.error).toBeUndefined();
  });

  it("cancels an agent run mid-turn and reports it cancelled", async () => {
    const { launched, next } = await movedTurn({
      agent: "helper",
      prompt: "Hold here",
    });
    await vi.waitFor(async () =>
      expect((await next.jobs.get(launched.id)).status).toBe("running")
    );
    await next.jobs.cancel(launched.id);
    await vi.waitFor(async () =>
      expect((await next.jobs.get(launched.id)).status).toBe("cancelled")
    );
    expect((await next.jobs.get(launched.id)).kind).toBe("agent");
  });

  it("cancels an agent run still queued and keeps its name and session", async () => {
    const { next, old } = await twoGenerations();
    const started = await old.jobs.start({ agent: "helper", prompt: "Wait" });
    const input = await queuedInput(old.engine, started);
    await next.jobs.start({ prompt: "Hold here" });
    const launched = await next.engine.launch(AGENT_DISPATCH, input);
    launched.result.catch(() => undefined);
    expect((await next.jobs.get(launched.id)).status).toBe("queued");
    const cancelled = await next.jobs.cancel(launched.id);
    expect(cancelled).toMatchObject({
      kind: "agent",
      name: "helper",
      status: "cancelled",
    });
    expect(cancelled.session?.id).toBe(started.session?.id);
    const read = await next.jobs.get(launched.id);
    expect(read).toMatchObject({ kind: "agent", name: "helper" });
    expect(read.session?.id).toBe(started.session?.id);
  });

  it("reads a workflow run with its output, and a queued one before it starts", async () => {
    const { next } = await twoGenerations();
    const done = await next.engine.launch<number>("next", { n: 1 });
    await done.result;
    expect(await next.jobs.get(done.id)).toMatchObject({
      kind: "workflow",
      name: "next",
      output: 2,
      runId: done.id,
      status: "completed",
    });
    await next.jobs.start({ prompt: "Hold here" });
    const waiting = await next.engine.launch<number>("next", { n: 5 });
    waiting.result.catch(() => undefined);
    expect(await next.jobs.get(waiting.id)).toMatchObject({
      kind: "workflow",
      name: "next",
      status: "queued",
    });
    expect((await next.jobs.cancel(waiting.id)).status).toBe("cancelled");
  });

  it("reports the failure of a run that failed", async () => {
    const sessions = new MemorySessionStore();
    const old = await host({ hold: () => true, sessions });
    const next = await host({
      reply: () => {
        throw new Error("model failed");
      },
      sessions,
    });
    await old.jobs.start({ prompt: "Block the queue" });
    const started = await old.jobs.start({ agent: "helper", prompt: "Fail" });
    const launched = await next.engine.launch(
      AGENT_DISPATCH,
      await queuedInput(old.engine, started)
    );
    await launched.result.catch(() => undefined);
    const read = await next.jobs.get(launched.id);
    expect(read.status).toBe("failed");
    expect(read.error).toContain("model failed");
  });

  it("still refuses a run the engine does not know", async () => {
    const { next } = await twoGenerations();
    await expect(next.jobs.get("rn-unknown")).rejects.toThrow(
      'no run "rn-unknown" in this host'
    );
    await expect(next.jobs.cancel("rn-unknown")).rejects.toThrow(
      'no run "rn-unknown" in this host'
    );
  });
});

describe("a dispatched run that moves between engine generations", () => {
  it("reads a queued workflow dispatch on the generation that took it, through the old one's exit", async () => {
    const fixture = await switchingWorkspace();
    const first = fixture.summary.pid ?? 0;
    const workspace = fixture.client.workspace(fixture.summary);
    const holding = workspace.roll("hold1");
    await whenLogged(fixture, `hold1 ${String(first)}`);
    const started = await workspace.dispatchWorkflow("hold2", {});
    expect(started.status).toBe("queued");

    const second = await switchFrom(fixture, first, 1);
    await whenLogged(fixture, `hold2 ${String(second)}`);
    expect(await workspace.getRun(started.runId)).toMatchObject({
      kind: "workflow",
      name: "hold2",
      runId: started.runId,
      status: "running",
    });

    const generations = await readLiveGenerations(fixture.machine.state);
    const retired = generations.find((generation) => generation.pid === first);
    expect(retired?.state).toBe("retiring");
    const mark = vi.spyOn(GenerationRecords.prototype, "mark");
    onTestFinished(() => {
      mark.mockRestore();
    });

    openGate(1, fixture);
    expect((await holding).value).toBe(first);
    const exit = await vi.waitFor(
      () => {
        const recorded = mark.mock.calls.find(
          ([number, state]) => number === retired?.number && state === "exited"
        );
        expect(recorded).toBeDefined();
        return recorded;
      },
      { interval: 50, timeout: 30_000 }
    );
    expect(exit?.[2]).toBeUndefined();
    expect((await workspace.getRun(started.runId)).status).toBe("running");

    openGate(2, fixture);
    await vi.waitFor(
      async () =>
        expect(await workspace.getRun(started.runId)).toMatchObject({
          output: second,
          status: "completed",
        }),
      { interval: 100, timeout: 30_000 }
    );
  }, 150_000);

  it("reads and cancels a suspended workflow dispatch on the generation that took it", async () => {
    const fixture = await switchingWorkspace();
    const first = fixture.summary.pid ?? 0;
    const workspace = fixture.client.workspace(fixture.summary);
    const started = await workspace.dispatchWorkflow("asking", {});
    await vi.waitFor(
      async () =>
        expect((await workspace.getRun(started.runId)).status).toBe(
          "suspended"
        ),
      { interval: 100, timeout: 30_000 }
    );

    await switchFrom(fixture, first, 1);
    await gone(first);
    expect(await workspace.getRun(started.runId)).toMatchObject({
      kind: "workflow",
      name: "asking",
      status: "suspended",
    });
    expect((await workspace.cancelRun(started.runId)).status).toBe("cancelled");
    expect((await workspace.getRun(started.runId)).status).toBe("cancelled");
  }, 150_000);

  it("runs a queued agent dispatch on the generation that took it, on the session the first opened", async () => {
    const fixture = await switchingWorkspace({
      daemon: {
        generationEntry: join(
          import.meta.dirname,
          "helpers",
          "generation-echo-models.ts"
        ),
      },
      providers: true,
    });
    const first = fixture.summary.pid ?? 0;
    const workspace = fixture.client.workspace(fixture.summary);
    const holding = workspace.roll("hold1");
    await whenLogged(fixture, `hold1 ${String(first)}`);
    const started = await workspace.dispatchAgent({
      instructions: "Answer briefly.",
      prompt: "Carry on after the switch",
    });
    expect(started.status).toBe("queued");

    await switchFrom(fixture, first, 1);
    const finished = await vi.waitFor(
      async () => {
        const read = await workspace.getRun(started.runId);
        expect(read.status).toBe("completed");
        return read;
      },
      { interval: 100, timeout: 30_000 }
    );
    expect(finished).toMatchObject({ kind: "agent", name: started.name });
    expect(finished.session?.id).toBe(started.session?.id);
    expect(finished.text).toContain("Answer briefly.");
    expect(finished.text).toContain("Carry on after the switch");

    openGate(1, fixture);
    expect((await holding).value).toBe(first);
    await gone(first);
    expect((await workspace.getRun(started.runId)).status).toBe("completed");
  }, 150_000);
});
