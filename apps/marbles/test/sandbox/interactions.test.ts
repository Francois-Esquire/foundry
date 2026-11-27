import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryAuthorization } from "@foundry/agents/authorization";
import { createHarnessPermission } from "@foundry/agents/harness";
import { Sessions } from "@foundry/agents/session";
import { MemorySessionStore } from "@foundry/agents/store/memory";
import { Authorization } from "@foundry/authorization";
import { SqliteAuthorizationStore } from "@foundry/authorization/store/sqlite";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { step } from "~/authoring/builder";
import { initializeDatabase } from "~/database/open";
import { DatabaseSessionStore } from "~/database/sessions";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import { approvalPrompt } from "~/lib/sandbox/interaction-prompts";
import { HarnessInteractions } from "~/lib/sandbox/interactions";

import { startEngine } from "../helpers/engine";
import { openFeed } from "../helpers/feed";

const source = { definition: "coding", path: ["coding"], runId: "run-1" };
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

async function fixture(authorization = createMemoryAuthorization()) {
  const feed = openFeed(undefined, { id: "test", root: "/workspace" });
  const sessions = new MemorySessionStore();
  await new Sessions({ store: sessions }).createSession({ id: "session-1" });
  const bridge = new HarnessInteractions({
    askable: true,
    authorization,
    feed: feed.publisher,
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
  return { authorization, bridge, feed, open, permission, sessions };
}

it("treats unknown approval choices as denied (positive allowlist)", () => {
  const prompt = approvalPrompt({
    agentId: "coder",
    approvalId: "a1",
    capability: { kind: "tool.call", source: "harness", tool: "bash" },
    input: { command: "bun test" },
    sessionId: "session-1",
    signal: new AbortController().signal,
    toolCallId: "c1",
    toolName: "bash",
  });
  expect(prompt.parse({ choice: "Approve once" }).approved).toBe(true);
  expect(prompt.parse({ choice: "Allow for this session" }).approved).toBe(
    true
  );
  expect(prompt.parse({ choice: "Deny" }).approved).toBe(false);
  expect(prompt.parse({ choice: "unexpected-value" }).approved).toBe(false);
  expect(prompt.parse({ choice: "" }).approved).toBe(false);
});

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
  await new Sessions({ store: f.sessions }).createSession({ id: "session-2" });
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

it("restores a scheduled refusal from durable pending grants without replaying its effect", async () => {
  const f = await fixture();
  expect(await f.permission(false)()).toMatchObject({ behavior: "deny" });
  const entry = await f.open();
  await f.bridge.close();
  const restored = new HarnessInteractions({
    askable: true,
    authorization: f.authorization,
    feed: f.feed.publisher,
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
  let bodies = 0;
  let bridge: HarnessInteractions | undefined;
  const coding = step("coding").do(async ({ run }) => {
    bodies += 1;
    return bridge?.question(
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
  const engine = await startEngine({
    artifacts: f.feed.artifacts,
    askable: true,
    collect: [coding],
    print: () => undefined,
    root: "/workspace",
    sessions: f.sessions,
  });
  bridge = engine.interactions;
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

it("remembers a deferred grant after reopening both session and authorization stores", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-durable-input-"));
  roots.push(root);
  const opened = await initializeDatabase(join(root, "marbles.db"));
  onTestFinished(() => opened.close());
  const feed = openFeed(undefined, { id: "durable", root });
  const open = () => {
    const kept = { database: opened.database, scope: "durable" };
    const sessions = new DatabaseSessionStore(kept);
    const authorization = new Authorization({
      store: new SqliteAuthorizationStore(kept),
    });
    return {
      authorization,
      bridge: new HarnessInteractions({
        askable: true,
        authorization,
        feed: feed.publisher,
        sessions,
      }),
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
  await new Sessions({ store: first.sessions }).createSession({
    id: "previous-run",
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
  await new Sessions({ store: third.sessions }).createSession({
    id: "next-run",
  });
  const allowed = createHarnessPermission({
    agentId: "coder",
    authorization: third.authorization,
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
    authorization: third.authorization,
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

it("cancels a deferred feed action backed by an embedding host's unrecoverable custom authorization", async () => {
  const f = await fixture();
  const custom = createMemoryAuthorization();
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
    ...f.bridge.authority(source, { authorization: custom }),
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
