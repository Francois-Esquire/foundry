import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve as resolvePath } from "node:path";
import { Models } from "@foundry/models";
import { step } from "@foundry.sh/marbles";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, expect, it, vi } from "vitest";
import { Catalog } from "~/authoring/catalog";
import type { Engine } from "~/lib/engine";
import { RunQueue } from "~/lib/run-queue";
import type { SessionRef } from "~/lib/types";
import { isJsonValue } from "~/lib/workflow-runs";
import type { RunInfo } from "~/model/connection";
import { BackgroundRuns } from "~/workspace/background-runs";
import { testEngine } from "./helpers/engine";
import { CODEX } from "./helpers/harnesses";

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
    cwd: "src",
    instructions: "Inspect only.",
    model: CODEX.model,
    prompt: "Inspect",
    provider: CODEX.provider,
  });
  await vi.waitFor(async () =>
    expect((await jobs.get(started.runId)).status).toBe("completed")
  );
  const finished = await jobs.get(started.runId);
  expect(finished.text).toContain(`${realpathSync(resolvePath("src"))}:codex:`);
  expect(finished.text).toContain("Inspect only.");
  expect(finished.text).toContain("Inspect");
});

async function contained() {
  const made = await mkdtemp(join(tmpdir(), "marbles-dispatch-cwd-"));
  const base = realpathSync(made);
  const root = join(base, "repo");
  const outside = join(base, "outside");
  const worktrees = join(base, "worktrees");
  await Promise.all([
    mkdir(join(root, "inner"), { recursive: true }),
    mkdir(outside),
    mkdir(join(worktrees, "stray"), { recursive: true }),
  ]);
  await writeFile(join(root, "README.md"), "repo\n");
  await symlink(outside, join(root, "link"));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
      { cwd: root, stdio: "ignore" }
    );
  git("init", "--quiet");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "init");
  const engine = testEngine({
    live: true,
    reply: ({ cwd }) => `cwd=${cwd}`,
    root,
    worktrees,
  });
  engines.push(engine);
  const jobs = new BackgroundRuns(engine, new Catalog());
  await engine.start();
  const finish = async (cwd: string) => {
    const started = await jobs.start({ cwd, prompt: "Where" });
    await vi.waitFor(async () =>
      expect((await jobs.get(started.runId)).status).toBe("completed")
    );
    return (await jobs.get(started.runId)).text;
  };
  return { base, engine, finish, jobs, outside, root, worktrees };
}

it("refuses a dispatch cwd outside the workspace and its Marbles worktrees", async () => {
  const { base, jobs, outside, root, worktrees } = await contained();
  try {
    for (const cwd of [
      outside,
      relative(root, outside),
      "../..",
      "link",
      join(worktrees, "stray"),
    ]) {
      await expect(jobs.start({ cwd, prompt: "Escape" }), cwd).rejects.toThrow(
        "outside the workspace root"
      );
    }
    await expect(
      jobs.start({ cwd: "missing", prompt: "Escape" })
    ).rejects.toThrow(`"${join(root, "missing")}"`);
    await expect(
      jobs.start({ cwd: "README.md", prompt: "Escape" })
    ).rejects.toThrow("not a directory");
  } finally {
    await rm(base, { force: true, recursive: true });
  }
});

it("starts a dispatch in the workspace or one of its Marbles worktrees", async () => {
  const { base, engine, finish, root } = await contained();
  try {
    expect(await finish("inner")).toContain(`cwd=${join(root, "inner")}`);
    expect(await finish(root)).toContain(`cwd=${root}`);
    const tree = await engine.workspaces.current.git.worktree({
      base: "HEAD",
    });
    expect(await finish(tree.root)).toContain(`cwd=${tree.root}`);
  } finally {
    await rm(base, { force: true, recursive: true });
  }
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
  ).rejects.toMatchObject({
    code: "TURN_LIMIT_UNSUPPORTED",
    message: expect.stringContaining("maxTurns is not supported"),
  });
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
  const models = new Models({
    providers: [
      {
        available: true,
        id: "network",
        languageModel: () => model,
        models: [{ id: "test", kind: "text", modelId: "test" }],
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
  expect((await jobs.cancel(started.runId)).status).toBe("cancelled");
  await jobs.close();
});

it("reuses one registered agent step and records serializable dispatch input", async () => {
  const engine = testEngine();
  engines.push(engine);
  const registrations = vi.spyOn(RunQueue.prototype, "register");
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

it.each(["workflow", "agent"] as const)(
  "acknowledges a queued background %s and retains it until admission",
  async (kind) => {
    const engine = testEngine({ pools: { default: { limit: 1 } } });
    engines.push(engine);
    const { promise, resolve: release } = Promise.withResolvers<void>();
    engine.define({ fn: () => promise, kind: "step", name: "blocking" });
    engine.define({ fn: () => "done", kind: "step", name: "queued" });
    const jobs = new BackgroundRuns(engine, new Catalog());
    await engine.start();
    await jobs.startWorkflow("blocking", {});
    try {
      const acknowledgement =
        kind === "workflow"
          ? await jobs.startWorkflow("queued", {})
          : await jobs.start({ prompt: "queued agent" });
      expect(acknowledgement.status).toBe("queued");
      expect((await jobs.get(acknowledgement.runId)).status).toBe("queued");
      release();
      await vi.waitFor(async () =>
        expect((await jobs.get(acknowledgement.runId)).status).toBe("completed")
      );
      if (kind === "agent") {
        expect((await jobs.get(acknowledgement.runId)).text).toContain(
          "queued agent"
        );
      }
    } finally {
      release();
      await jobs.close();
    }
  }
);

it.each(["running", "suspended"] as const)(
  "closing a peer that enqueues a keyed %s run leaves its owner's run alone",
  async (status) => {
    const state = await mkdtemp(join(tmpdir(), "marbles-background-peer-"));
    const release = Promise.withResolvers<void>();
    const peerKeyed = step("peer-keyed").do(async ({ ask }) => {
      if (status === "suspended") {
        await ask.approval({ title: "Continue?" });
      } else {
        await release.promise;
      }
      return "done";
    });
    const owner = testEngine({ askable: true, collect: [peerKeyed], state });
    const peer = testEngine({ askable: true, collect: [peerKeyed], state });
    const ownJobs = new BackgroundRuns(owner, new Catalog());
    const peerJobs = new BackgroundRuns(peer, new Catalog());
    try {
      await owner.start();
      await peer.start();
      const started = await ownJobs.startWorkflow(
        "peer-keyed",
        {},
        { key: "shared" }
      );
      await vi.waitFor(async () =>
        expect(
          await ownJobs.get(started.runId),
          "owner before peer enqueue"
        ).toMatchObject({ status })
      );
      const joined = await peerJobs.startWorkflow(
        "peer-keyed",
        {},
        { key: "shared" }
      );
      expect(joined.runId).toBe(started.runId);
      expect(peer.executions.get(joined.runId)).toBeDefined();
      expect(await peerJobs.list({ status: [status] })).toMatchObject({
        items: [{ id: started.runId, status }],
        total: 1,
      });
      await peerJobs.close();
      expect(
        (await ownJobs.get(started.runId)).status,
        "owner after peer close"
      ).toBe(status);
      expect(
        (await owner.runs()).find((run) => run.id === started.runId)?.status
      ).toBe(status);
    } finally {
      release.resolve();
      await owner.dispose();
      await peer.dispose();
      await rm(state, { force: true, recursive: true });
    }
  },
  10_000
);
it("lists agent and workflow runs newest first, filtered and paged, with completed and failed statuses", async () => {
  const engine = testEngine({ pools: { default: 1 } });
  engines.push(engine);
  const { promise, resolve: release } = Promise.withResolvers<void>();
  engine.define({ fn: () => "done", kind: "step", name: "fast" });
  engine.define({
    fn: () => {
      throw new Error("broke");
    },
    kind: "step",
    name: "broken",
  });
  engine.define({ fn: () => promise, kind: "step", name: "blocking" });
  const catalog = new Catalog();
  catalog.agents.set("helper", {
    id: "helper",
    kind: "agent",
    prompt: "Help with tasks.",
  });
  const jobs = new BackgroundRuns(engine, catalog);
  await engine.start();
  try {
    const fast = await jobs.startWorkflow("fast", {});
    await vi.waitFor(async () =>
      expect((await jobs.get(fast.runId)).status).toBe("completed")
    );
    const broken = await jobs.startWorkflow("broken", {});
    await vi.waitFor(async () =>
      expect((await jobs.get(broken.runId)).status).toBe("failed")
    );
    const agent = await jobs.start({ agent: "helper", prompt: "Hi" });
    await vi.waitFor(async () =>
      expect((await jobs.get(agent.runId)).status).toBe("completed")
    );
    const blocking = await jobs.startWorkflow("blocking", {});
    const queued = await jobs.startWorkflow("fast", {});
    expect(queued.status).toBe("queued");

    const all = await jobs.list();
    expect(all.total).toBe(5);
    expect(all.nextCursor).toBeUndefined();
    expect(all.items.map(({ id }) => id)).toEqual([
      queued.runId,
      blocking.runId,
      agent.runId,
      broken.runId,
      fast.runId,
    ]);
    expect(all.items[2]).toMatchObject({
      kind: "agent",
      name: "helper",
      session: { id: agent.session?.id },
      status: "completed",
    });
    expect(all.items[3]).toMatchObject({
      error: expect.stringContaining("broke"),
      kind: "workflow",
      name: "broken",
      status: "failed",
    });
    expect(all.items[4]).toMatchObject({ name: "fast", status: "completed" });
    for (const item of all.items) {
      expect(item).not.toHaveProperty("input");
      expect(item).not.toHaveProperty("output");
      expect(typeof item.queuedAt).toBe("string");
    }

    expect(
      (await jobs.list({ kind: "agent" })).items.map(({ id }) => id)
    ).toEqual([agent.runId]);
    expect(
      (await jobs.list({ name: "fast" })).items.map(({ id }) => id)
    ).toEqual([queued.runId, fast.runId]);
    expect(
      (await jobs.list({ status: ["completed"] })).items.map(({ id }) => id)
    ).toEqual([agent.runId, fast.runId]);
    expect(
      (await jobs.list({ status: ["queued", "failed"] })).items.map(
        ({ id }) => id
      )
    ).toEqual([queued.runId, broken.runId]);
    const first = await jobs.list({ limit: 2 });
    expect(first.items.map(({ id }) => id)).toEqual([
      queued.runId,
      blocking.runId,
    ]);
    expect(first.nextCursor).toBe(2);
    const second = await jobs.list({ cursor: first.nextCursor, limit: 2 });
    expect(second.items.map(({ id }) => id)).toEqual([
      agent.runId,
      broken.runId,
    ]);
    expect(second.nextCursor).toBe(4);

    const read = await jobs.get(fast.runId);
    expect(read.queuedAt).toEqual(expect.any(String));
    expect(read.startedAt).toEqual(expect.any(String));
    expect(read.endedAt).toEqual(expect.any(String));
  } finally {
    release();
    await jobs.close();
  }
});

it("preserves queued agent name and session after cancellation and rehosting", async () => {
  const state = await mkdtemp(join(tmpdir(), "marbles-bg-rehost-"));
  const { promise, resolve: release } = Promise.withResolvers<void>();
  const catalog = new Catalog();
  catalog.agents.set("helper", {
    id: "helper",
    kind: "agent",
    prompt: "Help with tasks.",
  });
  try {
    const first = testEngine({
      pools: { default: 1 },
      state,
    });
    engines.push(first);
    first.define({ fn: () => promise, kind: "step", name: "blocking" });
    const firstRuns = new BackgroundRuns(first, catalog);
    await first.start();
    const blocker = await firstRuns.startWorkflow("blocking", {});
    const queued = await firstRuns.start({
      agent: "helper",
      prompt: "Wait behind blocker",
    });
    expect(queued.status).toBe("queued");
    const cancelled = await firstRuns.cancel(queued.runId);
    expect(cancelled.status).toBe("cancelled");
    release();
    await vi.waitFor(async () =>
      expect((await firstRuns.get(blocker.runId)).status).toBe("completed")
    );
    await firstRuns.close();
    await first.dispose();

    const second = testEngine({ state });
    engines.push(second);
    second.define({ fn: () => "ok", kind: "step", name: "blocking" });
    const secondRuns = new BackgroundRuns(second, catalog);
    await second.start();
    try {
      const listed = await secondRuns.list({ name: "helper" });
      expect(listed.total).toBe(1);
      expect(listed.items[0]).toMatchObject({
        id: queued.runId,
        kind: "agent",
        name: "helper",
        session: { id: queued.session?.id },
        status: "cancelled",
      });
      const read = await secondRuns.get(queued.runId);
      expect(read).toMatchObject({
        kind: "agent",
        name: "helper",
        runId: queued.runId,
        session: { id: queued.session?.id },
        status: "cancelled",
      });
    } finally {
      await secondRuns.close();
    }
  } finally {
    release();
    await rm(state, { force: true, recursive: true });
  }
});

it("does not pair a running status with a final timestamp when a workflow settles mid-get", async () => {
  const engine = testEngine();
  engines.push(engine);
  const { promise, resolve: release } = Promise.withResolvers<string>();
  engine.define({ fn: () => promise, kind: "step", name: "slow" });
  const jobs = new BackgroundRuns(engine, new Catalog());
  await engine.start();
  const started = await jobs.startWorkflow("slow", {});
  try {
    await vi.waitFor(async () =>
      expect((await jobs.get(started.runId)).status).toBe("running")
    );
    const originalRuns = engine.runs.bind(engine);
    const runsSpy = vi
      .spyOn(engine, "runs")
      .mockImplementationOnce(async () => {
        const snapshot = await originalRuns();
        release("done");
        await vi.waitFor(async () =>
          expect(
            (await originalRuns()).find((r) => r.id === started.runId)?.status
          ).toBe("complete")
        );
        return snapshot;
      });
    const during = await jobs.get(started.runId);
    runsSpy.mockRestore();
    expect(during.status).toBe("running");
    expect(during.endedAt).toBeUndefined();
    const settled = await jobs.get(started.runId);
    expect(settled.status).toBe("completed");
    expect(settled.output).toBe("done");
    expect(settled.endedAt).toEqual(expect.any(String));
  } finally {
    release("done");
    await jobs.close();
  }
});

it("does not pair a running status with endedAt when a workflow settles mid-list", async () => {
  const engine = testEngine();
  engines.push(engine);
  const { promise, resolve: release } = Promise.withResolvers<string>();
  engine.define({ fn: () => promise, kind: "step", name: "slow" });
  const jobs = new BackgroundRuns(engine, new Catalog());
  await engine.start();
  const started = await jobs.startWorkflow("slow", {});
  try {
    await vi.waitFor(async () =>
      expect((await jobs.get(started.runId)).status).toBe("running")
    );
    const originalRuns = engine.runs.bind(engine);
    const runsSpy = vi
      .spyOn(engine, "runs")
      .mockImplementationOnce(async () => {
        const snapshot = await originalRuns();
        release("done");
        await vi.waitFor(async () =>
          expect(
            (await originalRuns()).find((r) => r.id === started.runId)?.status
          ).toBe("complete")
        );
        return snapshot;
      });
    const page = await jobs.list();
    runsSpy.mockRestore();
    const item = page.items.find((entry) => entry.id === started.runId);
    expect(item?.status).toBe("running");
    expect(item?.endedAt).toBeUndefined();
  } finally {
    release("done");
    await jobs.close();
  }
});
