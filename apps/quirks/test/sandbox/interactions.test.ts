import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentAuthorizer,
  createInMemoryAgentAuthorizer,
} from "@foundry/agents/authorization";
import { createHarnessPermission } from "@foundry/agents/harness";
import { InMemorySessionStore } from "@foundry/agents/session";
import { afterEach, expect, it, vi } from "vitest";
import { startEngine } from "~/engine";
import { openFeed } from "~/feed/store";
import { unbound } from "~/lib/bindings";
import { step } from "~/lib/builder";
import { catalog } from "~/lib/catalog";
import { createLog } from "~/lib/log";
import { runs } from "~/lib/run-scope";
import { registerCatalog } from "~/lib/tree";
import { JsonAgentGrantRepository } from "~/sandbox/grants";
import { HarnessInteractions } from "~/sandbox/interactions";
import { JsonSessionStore } from "~/sessions/json-store";
import type { FeedEntrySnapshot } from "~/views/dashboard-model";

const source = { definition: "coding", path: ["coding"], runId: "run-1" };
const roots: string[] = [];
afterEach(async () => {
  catalog.reset();
  runs.clear();
  for (const root of roots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

async function fixture(pendingPath?: string) {
  const feed = openFeed(undefined, { id: "test", root: "/workspace" });
  const sessions = new InMemorySessionStore();
  await sessions.createSession({ id: "session-1" });
  const policy = createInMemoryAgentAuthorizer().authorizer;
  const bridge = new HarnessInteractions({
    askable: true,
    feed: feed.publisher,
    pendingPath,
    policy,
    sessions,
  });
  const permission = (attended = true, sessionId = "session-1") => {
    const check = createHarnessPermission({
      agentId: "coder",
      profile: {
        allowedTools: [],
        disallowedTools: [],
        maxSteps: 10,
        mode: attended ? "attended" : "scheduled",
        unresolved: "ask",
      },
      store: sessions,
      ...bridge.authority(source),
    });
    return (signal = new AbortController().signal) =>
      check({
        input: { command: "bun test", token: "secret-test-value" },
        sessionId,
        signal,
        toolCallId: crypto.randomUUID(),
        toolName: "bash",
      });
  };
  const open = async () => {
    let entry: FeedEntrySnapshot | undefined;
    await vi.waitFor(async () => {
      entry = (await feed.read()).find((item) => item.input?.status === "open");
      expect(entry).toBeDefined();
    });
    if (!entry) {
      throw new Error("No open feed entry");
    }
    return entry;
  };
  return { bridge, feed, open, permission, policy, sessions };
}

it("keeps an attended permission pending, validates answers, and scopes a remembered grant", async () => {
  const f = await fixture();
  let ran = false;
  const pending = f
    .permission()()
    .then((result) => {
      ran = result.behavior === "allow";
      return result;
    });
  const entry = await f.open();
  expect(ran).toBe(false);
  expect(entry.body).toContain("bun test");
  expect(entry.body).not.toContain("secret-test-value");
  await expect(f.bridge.answer(entry.id, "unrecognized")).rejects.toThrow(
    "offered"
  );
  await f.bridge.answer(entry.id, "Allow for this session");
  expect(await pending).toEqual({ behavior: "allow" });
  expect(await f.permission()()).toEqual({ behavior: "allow" });
  expect(await f.bridge.answer(entry.id, "Deny")).toBe(false);
  await f.sessions.createSession({ id: "session-2" });
  const other = f.permission(true, "session-2")();
  const next = await f.open();
  await f.bridge.answer(next.id, {
    choice: "Deny",
    note: "Do not execute this.",
  });
  expect(await other).toMatchObject({
    behavior: "deny",
    message: "Do not execute this.",
  });
  await f.bridge.close();
});

it("restores a scheduled refusal as an actionable grant without replaying its effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "quirks-deferred-"));
  roots.push(root);
  const pendingPath = join(root, "pending.json");
  const f = await fixture(pendingPath);
  expect(await f.permission(false)()).toMatchObject({ behavior: "deny" });
  const entry = await f.open();
  await f.bridge.close();
  const restored = new HarnessInteractions({
    askable: true,
    feed: f.feed.publisher,
    pendingPath,
    policy: f.policy,
    sessions: f.sessions,
  });
  await restored.restore();
  expect(await restored.answer(entry.id, "Allow future runs")).toBe(true);
  expect(
    (await f.sessions.listMessages("session-1"))
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool_approval_response")
  ).toHaveLength(1);
  expect(await f.permission(false)()).toEqual({ behavior: "allow" });
  await restored.close();
});

it("returns free text and multiple selections, and treats declining as no answer", async () => {
  const f = await fixture();
  const ask = (multiSelect = false) =>
    f.bridge.question(
      source,
      {
        questions: [
          {
            id: "color",
            multiSelect,
            options: [{ label: "Red" }, { label: "Blue" }],
            question: "Which colors?",
          },
        ],
        sessionId: "session-1",
        signal: new AbortController().signal,
        toolCallId: crypto.randomUUID(),
      },
      true
    );
  const first = ask();
  const entry = await f.open();
  await f.bridge.answer(entry.id, "Write another answer");
  expect((await f.open()).input?.choices).toEqual([]);
  await f.bridge.answer(entry.id, "Green");
  expect(await first).toEqual({
    answers: { color: ["Green"] },
    outcome: "answered",
  });
  const second = ask(true);
  const multi = await f.open();
  await expect(f.bridge.answer(multi.id, ";")).rejects.toThrow("at least one");
  await f.bridge.answer(multi.id, "Red; Blue");
  expect(await second).toEqual({
    answers: { color: ["Red", "Blue"] },
    outcome: "answered",
  });
  const third = ask();
  await f.bridge.answer((await f.open()).id, "Decline to answer");
  expect(await third).toMatchObject({ outcome: "declined" });
  await f.bridge.close();
});

it("cancels live input and rejects a stale answer without granting permission", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const pending = f.permission()(controller.signal);
  const rejected = expect(pending).rejects.toThrow("cancelled");
  const entry = await f.open();
  controller.abort(new Error("cancelled"));
  await rejected;
  await f.bridge.close();
  expect(await f.bridge.answer(entry.id, "Approve once")).toBe(false);
  expect((await f.feed.read())[0]?.input?.status).toBe("cancelled");
  expect(
    (await f.sessions.listMessages("session-1"))
      .flatMap((message) => message.parts)
      .some((part) => part.type === "tool_approval_response")
  ).toBe(false);
});

it("routes live answers through the real engine without suspending or replaying its step", async () => {
  const f = await fixture();
  catalog.bind({
    agents: () => unbound("agents"),
    artifacts: () => unbound("artifacts"),
    log: createLog(() => undefined),
    root: "/workspace",
    sandboxes: () => unbound("sandboxes"),
    workspaces: () => unbound("workspaces"),
  });
  let bodies = 0;
  step("coding").do(async ({ run }) => {
    bodies += 1;
    return f.bridge.question(
      { ...source, runId: run.id },
      {
        questions: [{ id: "name", question: "Which name?" }],
        sessionId: "session-1",
        signal: run.signal,
        toolCallId: "question-1",
      },
      true
    );
  });
  const engine = await startEngine(registerCatalog, {
    askable: true,
    feed: f.feed.publisher,
    interactions: f.bridge,
    print: () => undefined,
  });
  try {
    const launched = await engine.launch("coding", {});
    const entry = await f.open();
    expect(
      (await engine.runs()).find((run) => run.id === launched.id)?.status
    ).toBe("running");
    await engine.answer(entry.id, "Ada");
    expect(await launched.result).toEqual({
      answers: { name: ["Ada"] },
      outcome: "answered",
    });
    expect(bodies).toBe(1);
  } finally {
    await engine.stop({ cancel: true });
  }
});

it("closes a question whose initial feed publication is still in flight", async () => {
  const f = await fixture();
  const publish = f.feed.publisher.publishInput.bind(f.feed.publisher);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  vi.spyOn(f.feed.publisher, "publishInput").mockImplementation(
    async (...args) => {
      writes += 1;
      if (writes === 1) {
        await gate;
      }
      return publish(...args);
    }
  );
  const pending = f.bridge.question(
    source,
    {
      questions: [{ id: "q", question: "Continue?" }],
      sessionId: "session-1",
      signal: new AbortController().signal,
      toolCallId: "delayed",
    },
    true
  );
  const rejected = expect(pending).rejects.toThrow("stopped waiting");
  const closing = f.bridge.close();
  release();
  await closing;
  await rejected;
  expect((await f.feed.read())[0]?.input?.status).toBe("cancelled");
});

it("does not reopen an aborted choice question via its other-answer action", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const pending = f.bridge.question(
    source,
    {
      questions: [{ id: "q", options: [{ label: "One" }], question: "Choose" }],
      sessionId: "session-1",
      signal: controller.signal,
      toolCallId: "race",
    },
    true
  );
  const rejected = expect(pending).rejects.toThrow("stopped");
  const entry = await f.open();
  controller.abort(new Error("stopped"));
  await expect(
    f.bridge.answer(entry.id, "Write another answer")
  ).rejects.toThrow("no longer");
  await rejected;
  await f.bridge.close();
  expect((await f.feed.read())[0]?.input?.status).toBe("cancelled");
});

it("recovers a canonical deferred request even if its publication callback never ran", async () => {
  const root = await mkdtemp(join(tmpdir(), "quirks-orphan-"));
  roots.push(root);
  const pendingPath = join(root, "pending.json");
  const f = await fixture(pendingPath);
  await f.bridge.registerSession({
    agentId: "coder",
    sessionId: "session-1",
    source,
  });
  const permission = createHarnessPermission({
    agentId: "coder",
    policy: f.policy,
    profile: {
      allowedTools: [],
      disallowedTools: [],
      maxSteps: 2,
      mode: "scheduled",
      unresolved: "ask",
    },
    store: f.sessions,
  });
  await permission({
    input: {},
    sessionId: "session-1",
    signal: new AbortController().signal,
    toolCallId: "orphan",
    toolName: "bash",
  });
  expect(await f.feed.read()).toEqual([]);
  await f.bridge.close();
  const restored = new HarnessInteractions({
    askable: true,
    feed: f.feed.publisher,
    pendingPath,
    policy: f.policy,
    sessions: f.sessions,
  });
  await restored.restore();
  await restored.answer((await f.open()).id, "Allow future runs");
  await f.sessions.createSession({ id: "new-run-session" });
  expect(await f.permission(false, "new-run-session")()).toEqual({
    behavior: "allow",
  });
  await restored.close();
});

it("repairs a deferred answer's feed state after publication failed without issuing another grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "quirks-feed-repair-"));
  roots.push(root);
  const pendingPath = join(root, "pending.json");
  const f = await fixture(pendingPath);
  await f.permission(false)();
  const entry = await f.open();
  const publish = f.feed.publisher.publishInput.bind(f.feed.publisher);
  const spy = vi
    .spyOn(f.feed.publisher, "publishInput")
    .mockImplementation(async (...args) => {
      if (args[2].status === "answered") {
        throw new Error("disk unavailable");
      }
      return publish(...args);
    });
  await expect(f.bridge.answer(entry.id, "Allow future runs")).rejects.toThrow(
    "disk unavailable"
  );
  await f.bridge.close();
  spy.mockRestore();
  const restored = new HarnessInteractions({
    askable: true,
    feed: f.feed.publisher,
    pendingPath,
    policy: f.policy,
    sessions: f.sessions,
  });
  await restored.restore();
  expect((await f.feed.read())[0]?.input).toMatchObject({
    answer: "Allow future runs",
    status: "answered",
  });
  expect(await restored.answer(entry.id, "Deny")).toBe(false);
  expect(
    (await f.sessions.listMessages("session-1"))
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool_approval_response")
  ).toHaveLength(1);
  await restored.close();
});

it("records an unattended question and returns a decline without waiting", async () => {
  const f = await fixture();
  expect(
    await f.bridge.question(
      source,
      {
        questions: [{ id: "q", question: "Which branch?" }],
        sessionId: "session-1",
        signal: new AbortController().signal,
        toolCallId: "scheduled",
      },
      false
    )
  ).toMatchObject({ outcome: "declined" });
  expect((await f.feed.read())[0]).toMatchObject({
    kind: "milestone",
    title: "Agent needs input",
  });
  await f.bridge.close();
});

it("remembers a deferred grant after reopening both session and authority stores", async () => {
  const root = await mkdtemp(join(tmpdir(), "quirks-durable-input-"));
  roots.push(root);
  const pendingPath = join(root, "pending.json");
  const feed = openFeed(undefined, { id: "durable", root });
  const open = () => {
    const sessions = new JsonSessionStore(join(root, "sessions"));
    const policy = createAgentAuthorizer({
      grants: new JsonAgentGrantRepository(join(root, "grants.json")),
    });
    return {
      bridge: new HarnessInteractions({
        askable: true,
        feed: feed.publisher,
        pendingPath,
        policy,
        sessions,
      }),
      policy,
      sessions,
    };
  };
  const profile = {
    allowedTools: [],
    disallowedTools: [],
    maxSteps: 2,
    mode: "scheduled" as const,
    unresolved: "ask" as const,
  };
  const first = open();
  await first.sessions.createSession({ id: "previous-run" });
  await first.bridge.registerSession({
    agentId: "coder",
    sessionId: "previous-run",
    source,
  });
  const request = {
    input: { command: "bun test" },
    sessionId: "previous-run",
    signal: new AbortController().signal,
    toolCallId: "attempt-1",
    toolName: "bash",
  };
  expect(
    await createHarnessPermission({
      agentId: "coder",
      profile,
      store: first.sessions,
      ...first.bridge.authority(source),
    })(request)
  ).toMatchObject({ behavior: "deny" });
  await first.bridge.close();
  const second = open();
  await second.bridge.restore();
  const entry = (await feed.read()).find(
    (item) => item.input?.status === "open"
  );
  if (!entry) {
    throw new Error("No restored grant request");
  }
  await second.bridge.answer(entry.id, "Allow future runs");
  await second.bridge.close();
  const third = open();
  await third.sessions.createSession({ id: "next-run" });
  const allowed = createHarnessPermission({
    agentId: "coder",
    policy: third.policy,
    profile,
    store: third.sessions,
  });
  expect(
    await allowed({
      ...request,
      sessionId: "next-run",
      toolCallId: "attempt-2",
    })
  ).toEqual({ behavior: "allow" });
  const unrelated = createHarnessPermission({
    agentId: "different-agent",
    policy: third.policy,
    profile,
    store: third.sessions,
  });
  expect(
    await unrelated({
      ...request,
      sessionId: "next-run",
      toolCallId: "attempt-3",
    })
  ).toMatchObject({ behavior: "deny" });
  await third.bridge.close();
});

it("cancels a deferred feed action backed by an embedding host's unrecoverable custom policy", async () => {
  const f = await fixture();
  const custom = createInMemoryAgentAuthorizer().authorizer;
  const permission = createHarnessPermission({
    agentId: "custom",
    profile: {
      allowedTools: [],
      disallowedTools: [],
      maxSteps: 2,
      mode: "scheduled",
      unresolved: "ask",
    },
    store: f.sessions,
    ...f.bridge.authority(source, { policy: custom }),
  });
  await permission({
    input: {},
    sessionId: "session-1",
    signal: new AbortController().signal,
    toolCallId: "custom",
    toolName: "bash",
  });
  const entry = await f.open();
  expect(entry.input?.delivery).toBeUndefined();
  await f.bridge.close();
  expect((await f.feed.read())[0]?.input?.status).toBe("cancelled");
  expect(await f.bridge.answer(entry.id, "Allow future runs")).toBe(false);
});
