import { ModelManager } from "@foundry/models";
import { Orchestrator } from "@foundry/workflows/orchestrator";
import { isJsonValue } from "@foundry/workflows/store";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, expect, it, vi } from "vitest";
import { Catalog } from "~/authoring/catalog";
import type { Engine } from "~/lib/engine";
import { CLAUDE_CODE, CODEX } from "~/lib/harnesses";
import type { SessionRef } from "~/lib/types";
import type { RunInfo } from "~/model/connection";
import { BackgroundRuns } from "~/workspace/background-runs";
import { testEngine } from "./helpers/engine";

const engines: Engine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) {
    await engine.dispose();
  }
});

async function dispatches(options: Parameters<typeof testEngine>[0] = {}) {
  const engine = testEngine(options);
  engines.push(engine);
  const catalog = new Catalog();
  catalog.agents.set("helper", {
    id: "helper",
    kind: "agent",
    prompt: "Help with tasks.",
  });
  const jobs = new BackgroundRuns(engine, catalog);
  await engine.start();
  return jobs;
}

function sessionOf(run: RunInfo): SessionRef {
  if (!run.session) {
    throw new Error("agent run has no session");
  }
  return run.session;
}

it("returns before a held agent finishes, then cancels it", async () => {
  const jobs = await dispatches({ hold: () => true });
  const started = await jobs.start({ agent: "helper", prompt: "Wait" });
  expect(["queued", "running"]).toContain(started.status);
  expect(sessionOf(started).id).toBeTruthy();
  expect(["queued", "running"]).toContain(
    (await jobs.get(started.runId)).status
  );
  await expect(
    jobs.start({
      agent: "helper",
      prompt: "Again",
      session: sessionOf(started),
    })
  ).rejects.toThrow("active agent dispatch");
  expect(["queued", "running", "cancelled"]).toContain(
    (await jobs.cancel(started.runId)).status
  );
  await vi.waitFor(async () =>
    expect((await jobs.get(started.runId)).status).toBe("cancelled")
  );
  expect((await jobs.get(started.runId)).text).toBeUndefined();
});

it("dispatches an ad hoc agent with route, instructions and working directory overrides", async () => {
  const jobs = await dispatches({
    reply: ({ cwd, executor, prompt }) =>
      `${cwd}:${executor.provider}:${prompt}`,
  });
  const started = await jobs.start({
    cwd: "/tmp",
    instructions: "Inspect only.",
    model: CODEX.model,
    prompt: "Inspect",
    provider: CODEX.provider,
  });
  await vi.waitFor(async () =>
    expect((await jobs.get(started.runId)).status).toBe("completed")
  );
  const finished = await jobs.get(started.runId);
  expect(finished.text).toContain("/tmp:codex:");
  expect(finished.text).toContain("Inspect only.");
  expect(finished.text).toContain("Inspect");
});

it("continues the returned session on a later dispatch", async () => {
  const jobs = await dispatches();
  const first = await jobs.start({ agent: "helper", prompt: "Remember this" });
  await vi.waitFor(async () =>
    expect((await jobs.get(first.runId)).status).toBe("completed")
  );
  const second = await jobs.start({
    agent: "helper",
    prompt: "Continue",
    session: sessionOf(first),
  });
  expect(sessionOf(second).id).toBe(sessionOf(first).id);
  await vi.waitFor(async () =>
    expect((await jobs.get(second.runId)).status).toBe("completed")
  );
  expect((await jobs.get(second.runId)).text).toContain("Remember this");
  expect((await jobs.get(second.runId)).text).toContain("Continue");
});

it("records timeouts and execution failures for retrieval", async () => {
  const held = await dispatches({ hold: () => true });
  const timed = await held.start({ prompt: "Wait", timeoutMs: 10 });
  await vi.waitFor(async () =>
    expect((await held.get(timed.runId)).status).toBe("failed")
  );
  expect((await held.get(timed.runId)).error).toContain(
    "agent dispatch timed out"
  );
  const broken = await dispatches({
    reply: () => {
      throw new Error("model failed");
    },
  });
  const failed = await broken.start({ prompt: "Fail" });
  await vi.waitFor(async () =>
    expect((await broken.get(failed.runId)).status).toBe("failed")
  );
  expect((await broken.get(failed.runId)).error).toContain("model failed");
});

it("stops background work on close and rejects new dispatches", async () => {
  const jobs = await dispatches({ hold: () => true });
  const started = await jobs.start({ prompt: "Wait" });
  await jobs.close();
  expect((await jobs.get(started.runId)).status).toBe("cancelled");
  await expect(jobs.start({ prompt: "New task" })).rejects.toThrow("closed");
});

it("rejects missing agents and unsupported native turn limits before dispatch", async () => {
  const jobs = await dispatches();
  await expect(
    jobs.start({ agent: "missing", prompt: "Hello" })
  ).rejects.toThrow("no agent");
  await expect(
    jobs.start({
      maxTurns: 3,
      model: CODEX.model,
      prompt: "Hello",
      provider: CODEX.provider,
    })
  ).rejects.toThrow("maxTurns is not supported");
});

it("runs multiple model/tool steps and stops at maxTurns", async () => {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: () => {
      calls += 1;
      return Promise.resolve({
        stream: simulateReadableStream({
          chunks: [
            {
              input: '{"action":"list"}',
              toolCallId: `call-${calls}`,
              toolName: "todo",
              type: "tool-call" as const,
            },
            {
              finishReason: { raw: undefined, unified: "tool-calls" as const },
              type: "finish" as const,
              usage: {
                inputTokens: {
                  cacheRead: 0,
                  cacheWrite: 0,
                  noCache: 1,
                  total: 1,
                },
                outputTokens: { reasoning: 0, text: 1, total: 1 },
              },
            },
          ],
        }),
      });
    },
  });
  const models = new ModelManager({
    providers: [
      {
        available: true,
        harness: "ai-sdk",
        id: "network",
        languageModel: () => model,
        models: [{ id: "test", kind: "text", modelId: "test" }],
        offline: false,
      },
    ],
  });
  const jobs = await dispatches({ models });
  const started = await jobs.start({
    maxTurns: 3,
    model: "test",
    prompt: "Keep listing tasks",
    provider: "network",
  });
  await vi.waitFor(async () =>
    expect((await jobs.get(started.runId)).status).toBe("completed")
  );
  expect(calls).toBe(3);
});

it("reports cancellation requested directly through the engine", async () => {
  const engine = testEngine();
  engines.push(engine);
  engine.define({
    fn: async ({ signal }) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
        } else {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }
      });
      signal.throwIfAborted();
    },
    kind: "step",
    name: "waiting",
  });
  const jobs = new BackgroundRuns(engine, new Catalog());
  await engine.start();
  const started = await jobs.startWorkflow("waiting", {});
  await engine.cancel(started.runId);
  await vi.waitFor(async () => {
    expect((await jobs.get(started.runId)).status).toBe("cancelled");
  });
  // Cancelling an already settled run remains harmless.
  expect((await jobs.cancel(started.runId)).status).toBe("cancelled");
  await jobs.close();
});

it("reuses one registered agent step and records serializable dispatch input", async () => {
  const engine = testEngine();
  engines.push(engine);
  const registrations = vi.spyOn(Orchestrator.prototype, "register");
  try {
    const jobs = new BackgroundRuns(engine, new Catalog());
    await engine.start();
    for (const prompt of ["First", "Second", "Third"]) {
      const run = await jobs.start({ prompt, timeoutMs: 1000 });
      await vi.waitFor(async () =>
        expect((await jobs.get(run.runId)).status).toBe("completed")
      );
    }
    const names = registrations.mock.calls.map(([name]) => name);
    expect(names.filter((name) => name === "agent-dispatch")).toHaveLength(1);
    expect(names.some((name) => name.startsWith("direct-"))).toBe(false);
    expect(jobs.definitions()).toEqual([]);
    const records = await engine.runs();
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(isJsonValue(record.input)).toBe(true);
      expect(record.input).toMatchObject({
        prompt: expect.any(String),
        session: { id: expect.any(String) },
        timeoutMs: 1000,
      });
    }
    await jobs.close();
  } finally {
    registrations.mockRestore();
  }
});

it.each([CLAUDE_CODE, CODEX])(
  "uses SDK steps for a dry run routed through $harness",
  async (executor) => {
    const jobs = await dispatches({ dry: true });
    const run = await jobs.start({
      maxTurns: 101,
      model: executor.model,
      prompt: "Hello",
      provider: executor.provider,
    });
    await vi.waitFor(async () =>
      expect((await jobs.get(run.runId)).status).toBe("completed")
    );
  }
);

it("can register the MCP dispatcher after the engine has started", async () => {
  const engine = testEngine();
  engines.push(engine);
  await engine.start();
  const jobs = new BackgroundRuns(engine, new Catalog());
  const run = await jobs.start({ prompt: "Hello" });
  await vi.waitFor(async () => {
    expect((await jobs.get(run.runId)).status).toBe("completed");
  });
  await jobs.close();
});

it("returns only an acknowledgement even when a workflow has already completed", async () => {
  const engine = testEngine();
  engines.push(engine);
  engine.define({ fn: () => "final result", kind: "step", name: "fast" });
  const jobs = new BackgroundRuns(engine, new Catalog());
  await engine.start();
  const launched = await engine.launch("fast", {});
  await launched.result;
  const launch = vi.spyOn(engine, "launch").mockResolvedValueOnce(launched);
  try {
    const acknowledgement = await jobs.startWorkflow("fast", {});
    expect(acknowledgement.status).toBe("completed");
    expect(acknowledgement).not.toHaveProperty("output");
    expect(acknowledgement).not.toHaveProperty("text");
    expect(acknowledgement).not.toHaveProperty("error");
    expect((await jobs.get(acknowledgement.runId)).output).toBe("final result");
  } finally {
    launch.mockRestore();
    await jobs.close();
  }
});
