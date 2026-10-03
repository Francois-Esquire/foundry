import { expect, it } from "vitest";

import { createInMemoryAgentAuthorizer } from "../../authorization";
import type { HarnessActivity, HarnessTurnDriver } from "../../harness";
import {
  createDriverSession,
  createHarnessActivityRecorder,
  reduceHarnessActivities,
} from "../../harness";
import { InMemorySessionStore, toModelMessages } from "../../session";

it("persists background activity across turns, rejects late progress, and reconstructs without model content", async () => {
  const store = new InMemorySessionStore();
  const activity: HarnessActivity = {
    id: "process-1:task-1",
    kind: "task",
    lifetime: "session",
    nativeId: "task-1",
    status: "running",
    title: "Run tests",
  };
  let turns = 0;
  const driver: HarnessTurnDriver = {
    capabilities: { interruption: true, steering: false },
    id: "native",
    async run(options) {
      await options.onActivity(activity);
      await options.onActivity(activity);
      turns += 1;
      if (turns === 2) {
        await options.onActivity({ ...activity, status: "complete" });
        await options.onActivity(activity);
      }
      return {
        async *[Symbol.asyncIterator]() {
          yield { delta: "done", type: "text-delta" };
        },
      };
    },
  };
  const config = {
    agentId: "coder",
    model: { harness: "native", id: "model" },
    policy: createInMemoryAgentAuthorizer().authorizer,
    profile: {
      allowedTools: [],
      disallowedTools: [],
      maxSteps: 10,
      mode: "scheduled" as const,
      unresolved: "deny" as const,
    },
    sessionId: "session",
    store,
  };
  const session = createDriverSession(config, driver);
  await session.generate("first");
  const first = await store.listMessages("session");
  expect(reduceHarnessActivities(first)).toEqual([
    expect.objectContaining({ ...activity, revision: 1 }),
  ]);
  await createDriverSession(config, driver).generate("second");
  const history = await store.listMessages("session");
  expect(reduceHarnessActivities([...history].reverse())).toEqual([
    expect.objectContaining({ revision: 2, status: "complete" }),
  ]);
  expect(
    history
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "harness_activity")
  ).toHaveLength(2);
  const audit = history.filter((message) =>
    message.parts.some((part) => part.type === "harness_activity")
  );
  expect(await toModelMessages(audit)).toEqual([]);
});

it("marks lost activity unknown and preserves native late terminal updates", async () => {
  const store = new InMemorySessionStore();
  let publish: ((activity: HarnessActivity) => Promise<void>) | undefined;
  const activity: HarnessActivity = {
    id: "p:child",
    kind: "subagent",
    lifetime: "sandbox",
    status: "waiting",
    title: "Review",
  };
  const session = createDriverSession(
    {
      agentId: "coder",
      model: { id: "model" },
      policy: createInMemoryAgentAuthorizer().authorizer,
      profile: {
        allowedTools: [],
        disallowedTools: [],
        maxSteps: 10,
        mode: "scheduled",
        unresolved: "deny",
      },
      sessionId: "session",
      store,
    },
    {
      capabilities: { interruption: true, steering: false },
      id: "native",
      async run(options) {
        publish = options.onActivity;
        await publish(activity);
        return {
          async *[Symbol.asyncIterator]() {
            yield { delta: "done", type: "text-delta" };
          },
        };
      },
    }
  );
  await session.generate("first");
  await session.close?.();
  expect(
    reduceHarnessActivities(await store.listMessages("session"))[0]?.status
  ).toBe("unknown");
  await publish?.({ ...activity, status: "complete" });
  expect(
    reduceHarnessActivities(await store.listMessages("session"))[0]?.status
  ).toBe("complete");
});

it("serializes concurrent recorders for the same native session", async () => {
  const store = new InMemorySessionStore();
  await store.createSession({ id: "session" });
  const config = {
    agentId: "coder",
    harness: "native",
    sessionId: "session",
    store,
  };
  const first = createHarnessActivityRecorder(config);
  const second = createHarnessActivityRecorder(config);
  const activity: HarnessActivity = {
    id: "p:task",
    kind: "task",
    lifetime: "session",
    status: "running",
    title: "Tests",
  };
  await Promise.all([
    first(activity),
    second({ ...activity, status: "complete" }),
  ]);
  const history = await store.listMessages("session");
  expect(
    history
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "harness_activity")
  ).toHaveLength(2);
  expect(reduceHarnessActivities(history)).toEqual([
    expect.objectContaining({ revision: 2, status: "complete" }),
  ]);
});

it.each([undefined, "native-child"])(
  "attributes nested native activities and requests before durable recording (%s)",
  async (nativeId) => {
    const store = new InMemorySessionStore();
    const requests: (string | undefined)[] = [];
    const session = createDriverSession(
      {
        agentId: "coder",
        model: { id: "model" },
        onApprovalRequest: (request) => {
          requests.push(request.activityId);
        },
        parentActivityId: "managed-child",
        policy: createInMemoryAgentAuthorizer().authorizer,
        profile: {
          allowedTools: [],
          disallowedTools: [],
          maxSteps: 10,
          mode: "scheduled",
          unresolved: "ask",
        },
        question: async (request) => {
          requests.push(request.activityId);
          return { outcome: "declined", reason: "No answer" };
        },
        sessionId: "session",
        store,
      },
      {
        capabilities: { interruption: true, steering: false },
        id: "native",
        async run(options) {
          await options.onActivity({
            id: "native-task",
            kind: "task",
            lifetime: "session",
            status: "running",
            title: "Native work",
          });
          await options.permission({
            input: {},
            sessionId: "session",
            signal: options.signal,
            toolCallId: "tool",
            toolName: "Bash",
            ...(nativeId ? { activityId: nativeId } : {}),
          });
          await options.question({
            questions: [{ id: "q", question: "Continue?" }],
            sessionId: "session",
            signal: options.signal,
            toolCallId: "question",
            ...(nativeId ? { activityId: nativeId } : {}),
          });
          return {
            async *[Symbol.asyncIterator]() {
              yield { delta: "done", type: "text-delta" };
            },
          };
        },
      }
    );
    await session.generate("first");
    const expectedId = nativeId ?? "managed-child";
    expect(requests).toEqual([expectedId, expectedId]);
    const history = await store.listMessages("session");
    expect(reduceHarnessActivities(history)[0]?.parentId).toBe("managed-child");
    const attributed = history
      .flatMap((message) => message.parts)
      .filter(
        (part) =>
          part.type === "tool_approval_request" ||
          part.type === "harness_question"
      );
    expect(attributed).toHaveLength(3);
    expect(attributed.every((part) => part.activityId === expectedId)).toBe(
      true
    );
  }
);

it("continues delivering idle native questions after the prior turn signal aborts", async () => {
  const store = new InMemorySessionStore();
  const turn = new AbortController();
  let question: import("../../harness").HarnessQuestionCallback | undefined;
  const session = createDriverSession(
    {
      agentId: "coder",
      model: { id: "model" },
      policy: createInMemoryAgentAuthorizer().authorizer,
      profile: {
        allowedTools: [],
        disallowedTools: [],
        maxSteps: 10,
        mode: "attended",
        unresolved: "ask",
      },
      question: async () => ({ outcome: "declined", reason: "No answer" }),
      sessionId: "session",
      store,
    },
    {
      capabilities: { interruption: true, steering: false },
      id: "native",
      async run(options) {
        ({ question } = options);
        return {
          async *[Symbol.asyncIterator]() {
            yield { delta: "done", type: "text-delta" };
          },
        };
      },
    }
  );
  await session.generate("first", { signal: turn.signal });
  turn.abort();
  const result = await question?.({
    questions: [{ id: "q", question: "Continue?" }],
    sessionId: "session",
    signal: new AbortController().signal,
    toolCallId: "idle-question",
  });
  expect(result).toEqual({ outcome: "declined", reason: "No answer" });
  await session.close?.();
});

it("never makes the host delegation root its own parent when closing loaded history", async () => {
  const store = new InMemorySessionStore();
  await store.createSession({ id: "child-session" });
  await createHarnessActivityRecorder({
    agentId: "coder",
    harness: "native",
    sessionId: "child-session",
    store,
  })({
    id: "managed-child",
    kind: "subagent",
    lifetime: "session",
    status: "running",
    title: "Review",
  });
  const session = createDriverSession(
    {
      agentId: "coder",
      model: { id: "model" },
      parentActivityId: "managed-child",
      policy: createInMemoryAgentAuthorizer().authorizer,
      profile: {
        allowedTools: [],
        disallowedTools: [],
        maxSteps: 10,
        mode: "scheduled",
        unresolved: "deny",
      },
      sessionId: "child-session",
      store,
    },
    {
      capabilities: { interruption: true, steering: false },
      id: "native",
      async run() {
        return {
          async *[Symbol.asyncIterator]() {
            yield { delta: "done", type: "text-delta" };
          },
        };
      },
    }
  );
  await session.generate("first");
  await session.close?.();
  const [root] = reduceHarnessActivities(
    await store.listMessages("child-session")
  );
  expect(root?.status).toBe("unknown");
  expect(root?.parentId).toBeUndefined();
});

it("preserves external completion during close and rejects stale loss of one-shot work", async () => {
  const store = new InMemorySessionStore();
  const session = createDriverSession(
    {
      agentId: "coder",
      model: { id: "model" },
      policy: createInMemoryAgentAuthorizer().authorizer,
      profile: {
        allowedTools: [],
        disallowedTools: [],
        maxSteps: 10,
        mode: "scheduled",
        unresolved: "deny",
      },
      sessionId: "session",
      store,
    },
    {
      capabilities: { interruption: true, steering: false },
      id: "native",
      async run(options) {
        await options.onActivity({
          id: "task",
          kind: "task",
          lifetime: "session",
          status: "running",
          title: "Work",
        });
        return {
          async *[Symbol.asyncIterator]() {
            yield { delta: "done", type: "text-delta" };
          },
        };
      },
    }
  );
  await session.generate("first");
  const record = createHarnessActivityRecorder({
    agentId: "coder",
    harness: "native",
    sessionId: "session",
    store,
  });
  const completed: HarnessActivity = {
    id: "task",
    kind: "task",
    lifetime: "session",
    status: "complete",
    title: "Work",
  };
  await record(completed);
  await session.close?.();
  await record({ ...completed, status: "unknown" });
  expect(reduceHarnessActivities(await store.listMessages("session"))).toEqual([
    expect.objectContaining({ revision: 2, status: "complete" }),
  ]);
});

it("checks canonical activity state before native stop after external completion", async () => {
  const store = new InMemorySessionStore();
  const stops: string[] = [];
  const activity: HarnessActivity = {
    actions: ["stop"],
    id: "task",
    kind: "task",
    lifetime: "session",
    status: "running",
    title: "Work",
  };
  const session = createDriverSession(
    {
      agentId: "coder",
      model: { id: "model" },
      policy: createInMemoryAgentAuthorizer().authorizer,
      profile: {
        allowedTools: [],
        disallowedTools: [],
        maxSteps: 10,
        mode: "scheduled",
        unresolved: "deny",
      },
      sessionId: "session",
      store,
    },
    {
      capabilities: { interruption: true, steering: false },
      id: "native",
      async run(options) {
        await options.onActivity(activity);
        return {
          async *[Symbol.asyncIterator]() {
            yield { delta: "done", type: "text-delta" };
          },
        };
      },
      async stopActivity(id) {
        stops.push(id);
      },
    }
  );
  await session.generate("first");
  await session.stopActivity?.("task");
  await createHarnessActivityRecorder({
    agentId: "coder",
    harness: "native",
    sessionId: "session",
    store,
  })({ ...activity, status: "complete" });
  await expect(session.stopActivity?.("task")).rejects.toThrow(
    "Activity does not support stopping"
  );
  expect(stops).toEqual(["task"]);
  await session.close?.();
});
