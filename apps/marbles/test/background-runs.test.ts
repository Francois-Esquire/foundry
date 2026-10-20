import { ModelManager } from "@foundry/models";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, expect, it, vi } from "vitest";
import { Catalog } from "~/authoring/catalog";
import type { Engine } from "~/lib/engine";
import { CODEX } from "~/lib/harnesses";
import type { SessionRef } from "~/lib/types";
import { BackgroundRuns, type RunInfo } from "~/runs";
import { testEngine } from "./helpers/engine";

const engines: Engine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) {
    await engine.dispose();
  }
});

function dispatches(options: Parameters<typeof testEngine>[0] = {}) {
  const engine = testEngine(options);
  engines.push(engine);
  const catalog = new Catalog();
  catalog.agents.set("helper", {
    id: "helper",
    kind: "agent",
    prompt: "Help with tasks.",
  });
  return new BackgroundRuns(engine, catalog);
}

function sessionOf(run: RunInfo): SessionRef {
  if (!run.session) {
    throw new Error("agent run has no session");
  }
  return run.session;
}

it("returns before a held agent finishes, then cancels it", async () => {
  const jobs = dispatches({ hold: () => true });
  const started = await jobs.start({ agent: "helper", prompt: "Wait" });
  expect(started.status).toBe("running");
  expect(sessionOf(started).id).toBeTruthy();
  expect(jobs.get(started.runId).status).toBe("running");
  await expect(
    jobs.start({
      agent: "helper",
      prompt: "Again",
      session: sessionOf(started),
    })
  ).rejects.toThrow("active agent dispatch");
  expect(["cancelling", "cancelled"]).toContain(
    (await jobs.cancel(started.runId)).status
  );
  await vi.waitFor(() =>
    expect(jobs.get(started.runId).status).toBe("cancelled")
  );
  expect(jobs.get(started.runId).text).toBeUndefined();
});

it("dispatches an ad hoc agent with route, instructions and working directory overrides", async () => {
  const jobs = dispatches({
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
  await vi.waitFor(() =>
    expect(jobs.get(started.runId).status).toBe("completed")
  );
  const finished = jobs.get(started.runId);
  expect(finished.text).toContain("/tmp:codex:");
  expect(finished.text).toContain("Inspect only.");
  expect(finished.text).toContain("Inspect");
});

it("continues the returned session on a later dispatch", async () => {
  const jobs = dispatches();
  const first = await jobs.start({ agent: "helper", prompt: "Remember this" });
  await vi.waitFor(() =>
    expect(jobs.get(first.runId).status).toBe("completed")
  );
  const second = await jobs.start({
    agent: "helper",
    prompt: "Continue",
    session: sessionOf(first),
  });
  expect(sessionOf(second).id).toBe(sessionOf(first).id);
  await vi.waitFor(() =>
    expect(jobs.get(second.runId).status).toBe("completed")
  );
  expect(jobs.get(second.runId).text).toContain("Remember this");
  expect(jobs.get(second.runId).text).toContain("Continue");
});

it("records timeouts and execution failures for retrieval", async () => {
  const held = dispatches({ hold: () => true });
  const timed = await held.start({ prompt: "Wait", timeoutMs: 10 });
  await vi.waitFor(() => expect(held.get(timed.runId).status).toBe("failed"));
  expect(held.get(timed.runId).error).toContain("agent dispatch timed out");
  const broken = dispatches({
    reply: () => {
      throw new Error("model failed");
    },
  });
  const failed = await broken.start({ prompt: "Fail" });
  await vi.waitFor(() =>
    expect(broken.get(failed.runId).status).toBe("failed")
  );
  expect(broken.get(failed.runId).error).toContain("model failed");
});

it("stops background work on close and rejects new dispatches", async () => {
  const jobs = dispatches({ hold: () => true });
  const started = await jobs.start({ prompt: "Wait" });
  await jobs.close();
  expect(jobs.get(started.runId).status).toBe("cancelled");
  await expect(jobs.start({ prompt: "New task" })).rejects.toThrow("closed");
});

it("rejects missing agents and unsupported native turn limits before dispatch", async () => {
  const jobs = dispatches();
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
  const jobs = dispatches({ models });
  const started = await jobs.start({
    maxTurns: 3,
    model: "test",
    prompt: "Keep listing tasks",
    provider: "network",
  });
  await vi.waitFor(() =>
    expect(jobs.get(started.runId).status).toBe("completed")
  );
  expect(calls).toBe(3);
});
