import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentAuthorizer,
  createInMemoryAgentAuthorizer,
} from "@foundry/agents/authorization";
import { createHarnessPermission } from "@foundry/agents/harness";
import { Sessions } from "@foundry/agents/session";
import type { SessionStore } from "@foundry/agents/store";
import { MemorySessionStore } from "@foundry/agents/store/memory";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { step } from "~/authoring/builder";
import { catalog } from "~/authoring/catalog";
import { DatabaseDeferredApprovalStore } from "~/database/approvals";
import { DatabaseGrantStorage } from "~/database/grants";
import { initializeDatabase } from "~/database/open";
import { DatabaseSessionStore } from "~/database/sessions";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import type { DeferredApprovalStore } from "~/lib/sandbox/deferred-approvals";
import { MemoryDeferredApprovalStore } from "~/lib/sandbox/deferred-approvals";
import { StoredAgentGrantRepository } from "~/lib/sandbox/grants";
import { HarnessInteractions } from "~/lib/sandbox/interactions";

import { startEngine } from "../helpers/engine";
import { openFeed } from "../helpers/feed";

const source = { definition: "coding", path: ["coding"], runId: "run-1" };
const roots: string[] = [];
afterEach(async () => {
  catalog.reset();
  for (const root of roots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

async function fixture(approvals?: DeferredApprovalStore) {
  const feed = openFeed(undefined, { id: "test", root: "/workspace" });
  const sessions = new MemorySessionStore();
  await new Sessions({ store: sessions }).createSession({ id: "session-1" });
  const policy = createInMemoryAgentAuthorizer().authorizer;
  const bridge = new HarnessInteractions({
    askable: true,
    feed: feed.publisher,
    ...(approvals ? { approvals } : {}),
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

it("does not reopen a question another host answered while it was restoring", async () => {
  const approvals = new MemoryDeferredApprovalStore();
  const f = await fixture(approvals);
  expect(await f.permission(false)()).toMatchObject({ behavior: "deny" });
  const entry = await f.open();
  const { promise: held, resolve: resume } = Promise.withResolvers<undefined>();
  let entered: (() => void) | undefined;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let first = true;
  const sessions: SessionStore = {
    commit: (write) => f.sessions.commit(write),
    getMessage: (id) => f.sessions.getMessage(id),
    getSession: (id) => f.sessions.getSession(id),
    async listMessages(sessionId) {
      const messages = await f.sessions.listMessages(sessionId);
      if (first) {
        first = false;
        entered?.();
        await held;
      }
      return messages;
    },
  };
  const stale = new HarnessInteractions({
    approvals,
    askable: true,
    feed: f.feed.publisher,
    policy: f.policy,
    sessions,
  });
  const restoring = stale.restore();
  await reading;
  await f.bridge.answer(entry.id, "Deny");
  resume(undefined);
  await restoring;
  expect((await f.feed.read())[0]?.input?.status).toBe("answered");
  expect(await stale.answer(entry.id, "Allow future runs")).toBe(false);
  await f.bridge.close();
  await stale.close();
});

it("restores a scheduled refusal as an actionable grant without replaying its effect", async () => {
  const approvals = new MemoryDeferredApprovalStore();
  const f = await fixture(approvals);
  expect(await f.permission(false)()).toMatchObject({ behavior: "deny" });
  const entry = await f.open();
  await f.bridge.close();
  const restored = new HarnessInteractions({
    approvals,
    askable: true,
    feed: f.feed.publisher,
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
  let bodies = 0;
  let bridge: HarnessInteractions | undefined;
  step("coding").do(async ({ run }) => {
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

it("recovers a canonical deferred request even if its publication callback never ran", async () => {
  const approvals = new MemoryDeferredApprovalStore();
  const f = await fixture(approvals);
  await f.bridge.registerSession(
    { agentId: "coder", sessionId: "session-1", source },
    f.bridge.authority(source)
  );
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
    approvals,
    askable: true,
    feed: f.feed.publisher,
    policy: f.policy,
    sessions: f.sessions,
  });
  await restored.restore();
  await restored.answer((await f.open()).id, "Allow future runs");
  await new Sessions({ store: f.sessions }).createSession({
    id: "new-run-session",
  });
  expect(await f.permission(false, "new-run-session")()).toEqual({
    behavior: "allow",
  });
  await restored.close();
});

it("keeps sessions across restarts only under an authority the host built over its own policy", async () => {
  const approvals = new MemoryDeferredApprovalStore();
  const f = await fixture(approvals);
  const session = { agentId: "coder", sessionId: "session-1", source };
  const custom = createInMemoryAgentAuthorizer().authorizer;
  await f.bridge.registerSession(
    session,
    f.bridge.authority(source, { policy: custom })
  );
  await f.bridge.registerSession(session, { policy: f.policy });
  await f.bridge.registerSession(session, {
    ...f.bridge.authority(source),
  });
  expect((await approvals.load()).sessions).toEqual([]);
  await f.bridge.registerSession(session, f.bridge.authority(source));
  expect((await approvals.load()).sessions).toEqual([session]);
  await f.bridge.close();
});

it("repairs a deferred answer's feed state after publication failed without issuing another grant", async () => {
  const approvals = new MemoryDeferredApprovalStore();
  const f = await fixture(approvals);
  await f.permission(false)();
  const entry = await f.open();
  const grants = vi.spyOn(f.policy, "resolveApproval");
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
    approvals,
    askable: true,
    feed: f.feed.publisher,
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
  expect(grants).toHaveBeenCalledTimes(1);
  await restored.close();
});

it("issues on restore the grant a stored deferred answer never got, and only once", async () => {
  const approvals = new MemoryDeferredApprovalStore();
  const f = await fixture(approvals);
  await f.permission(false)();
  const entry = await f.open();
  const resolveApproval = f.policy.resolveApproval.bind(f.policy);
  let failures = 1;
  const grants = vi
    .spyOn(f.policy, "resolveApproval")
    .mockImplementation((auth, resolution) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error("grants unavailable"));
      }
      return resolveApproval(auth, resolution);
    });
  await expect(f.bridge.answer(entry.id, "Allow future runs")).rejects.toThrow(
    "grants unavailable"
  );
  await f.bridge.close();
  const restore = () => {
    const restored = new HarnessInteractions({
      approvals,
      askable: true,
      feed: f.feed.publisher,
      policy: f.policy,
      sessions: f.sessions,
    });
    onTestFinished(() => restored.close());
    return restored.restore();
  };

  await restore();

  expect((await f.feed.read())[0]?.input).toMatchObject({
    answer: "Allow future runs",
    status: "answered",
  });
  expect((await approvals.load()).requests).toEqual([]);
  await new Sessions({ store: f.sessions }).createSession({
    id: "new-run-session",
  });
  expect(await f.permission(false, "new-run-session")()).toEqual({
    behavior: "allow",
  });
  await restore();
  expect(grants).toHaveBeenCalledTimes(2);
});

it("leaves a stored deferred answer's question open, and its record kept, when its grant fails again on restore", async () => {
  const approvals = new MemoryDeferredApprovalStore();
  const f = await fixture(approvals);
  await f.permission(false)();
  const entry = await f.open();
  const resolveApproval = f.policy.resolveApproval.bind(f.policy);
  let failures = 2;
  vi.spyOn(f.policy, "resolveApproval").mockImplementation(
    (auth, resolution) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error("grants unavailable"));
      }
      return resolveApproval(auth, resolution);
    }
  );
  await expect(f.bridge.answer(entry.id, "Allow future runs")).rejects.toThrow(
    "grants unavailable"
  );
  await f.bridge.close();
  const restored = new HarnessInteractions({
    approvals,
    askable: true,
    feed: f.feed.publisher,
    policy: f.policy,
    sessions: f.sessions,
  });
  onTestFinished(() => restored.close());

  await restored.restore();

  expect(failures).toBe(0);
  const reopened = await f.open();
  expect((await approvals.load()).requests).toHaveLength(1);
  await expect(restored.answer(reopened.id, "Deny")).rejects.toThrow(
    "already has a response"
  );
  expect(await restored.answer(reopened.id, "Allow future runs")).toBe(true);
  expect((await approvals.load()).requests).toEqual([]);
  await new Sessions({ store: f.sessions }).createSession({
    id: "new-run-session",
  });
  expect(await f.permission(false, "new-run-session")()).toEqual({
    behavior: "allow",
  });
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
  const root = await mkdtemp(join(tmpdir(), "marbles-durable-input-"));
  roots.push(root);
  const opened = await initializeDatabase(join(root, "marbles.db"));
  onTestFinished(() => opened.close());
  const feed = openFeed(undefined, { id: "durable", root });
  const open = () => {
    const kept = { database: opened.database, scope: "durable" };
    const sessions = new DatabaseSessionStore(kept);
    const policy = createAgentAuthorizer({
      grants: new StoredAgentGrantRepository(new DatabaseGrantStorage(kept)),
    });
    return {
      bridge: new HarnessInteractions({
        approvals: new DatabaseDeferredApprovalStore(kept),
        askable: true,
        feed: feed.publisher,
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
  await new Sessions({ store: first.sessions }).createSession({
    id: "previous-run",
  });
  await first.bridge.registerSession(
    { agentId: "coder", sessionId: "previous-run", source },
    first.bridge.authority(source)
  );
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
