import type { LanguageModelV4 } from "@ai-sdk/provider";
import type {
  HarnessActivity,
  HarnessPermissionRequest,
  HarnessQuestionRequest,
} from "@foundry/agents/harness";
import { createHarnessQuestionTool } from "@foundry/agents/harness";
import {
  type ClaudeCodeSettings,
  createClaudeCodeQueryController,
} from "ai-sdk-provider-claude-code";
import { describe, expect, it, vi } from "vitest";
import { createClaudeCodeDriver } from "../harness/claude-code";
import { createCodexDriver } from "../harness/codex";
import { createNativeActivities } from "../harness/native-activity";
import { collect, FakeAppServer, runOptions } from "./helpers/cli";

function fixture(generation = "process-1") {
  const events: HarnessActivity[] = [];
  const activities = createNativeActivities(
    runOptions({
      onActivity: async (activity) => {
        events.push(activity);
      },
    }),
    generation
  );
  return { activities, events };
}

describe("native activity protocol", () => {
  it("observes Claude task edges, updates and actual terminal statuses without exposing invented controls", async () => {
    const { activities, events } = fixture();
    await activities.claudeMessage({
      description: "Checking",
      subagent_type: "Explore",
      subtype: "task_started",
      task_id: "task-1",
      type: "system",
    });
    await activities.claudeMessage({
      patch: { description: "Checking more" },
      subtype: "task_updated",
      task_id: "task-1",
      type: "system",
    });
    await activities.claudeMessage({
      patch: { status: "paused" },
      subtype: "task_updated",
      task_id: "task-1",
      type: "system",
    });
    expect(events.map((event) => event.status)).toEqual([
      "running",
      "running",
      "waiting",
    ]);
    expect(events[0]).toMatchObject({
      actions: ["stop"],
      kind: "subagent",
      lifetime: "session",
    });
    expect(activities.taskId(events[0]?.id ?? "")).toBe("task-1");
    await activities.claudeMessage({
      status: "stopped",
      subtype: "task_notification",
      task_id: "task-1",
      type: "system",
    });
    expect(events.at(-1)).toMatchObject({ actions: [], status: "cancelled" });
    expect(activities.taskId(events[0]?.id ?? "")).toBeUndefined();
  });

  it("does not infer subagent completion from a pre-stop hook or process loss", async () => {
    const { activities, events } = fixture();
    await activities.claudeHook({
      agent_id: "child-1",
      agent_type: "Explore",
      hook_event_name: "SubagentStart",
    });
    await activities.claudeHook({
      agent_id: "child-1",
      agent_type: "Explore",
      hook_event_name: "SubagentStop",
    });
    expect(events.at(-1)?.status).toBe("unknown");
    await activities.claudeMessage({
      subtype: "task_started",
      task_id: "background-1",
      type: "system",
    });
    await activities.close();
    expect(events.at(-1)).toMatchObject({ actions: [], status: "unknown" });
    await activities.claudeMessage({
      subtype: "task_started",
      task_id: "late-task",
      type: "system",
    });
    expect(events.at(-1)).toMatchObject({ actions: [], status: "unknown" });
    expect(activities.taskId(events.at(-1)?.id ?? "")).toBeUndefined();
    expect(fixture("process-2").activities.id("child-1")).not.toBe(
      activities.id("child-1")
    );
  });

  it("ignores incomplete activity identities and uses child states rather than completed collab call status", async () => {
    const { activities, events } = fixture();
    await activities.claudeMessage({ subtype: "task_started", type: "system" });
    await activities.claudeHook({ hook_event_name: "SubagentStart" });
    expect(events).toEqual([]);
    await activities.codexItem({
      agentsStates: { child: { status: "running" } },
      receiverThreadIds: ["child"],
      senderThreadId: "root",
      status: "completed",
      tool: "spawnAgent",
      type: "collabAgentToolCall",
    });
    expect(events.at(-1)).toMatchObject({
      kind: "subagent",
      nativeId: "child",
      status: "running",
    });
    await activities.codexItem({
      agentsStates: { grandchild: { status: "pendingInit" } },
      receiverThreadIds: ["grandchild"],
      senderThreadId: "child",
      tool: "spawnAgent",
      type: "collabAgentToolCall",
    });
    expect(events.at(-1)).toMatchObject({
      parentId: activities.id("child"),
      status: "waiting",
    });
    await activities.codexTurn("child", "completed");
    expect(events.at(-1)?.status).toBe("complete");
    await activities.close();
    expect(events.findLast((event) => event.nativeId === "child")?.status).toBe(
      "complete"
    );
  });

  it("subscribes to Codex child threads and never lets their turn or text finish the parent", async () => {
    const child = new FakeAppServer();
    const events: HarnessActivity[] = [];
    const driver = createCodexDriver({
      agentId: "agent",
      apiKey: "test",
      binPath: "codex",
      cwd: "/workspace",
      modelId: "gpt",
      spawn: async () => child,
    });
    const stream = await driver.run(
      runOptions({
        onActivity: async (activity) => {
          events.push(activity);
        },
        profile: {
          allowedTools: [],
          disallowedTools: [],
          maxSteps: 10,
          mode: "scheduled",
          unresolved: "deny",
        },
      })
    );
    const result = collect(stream);
    child.send({
      method: "item/completed",
      params: {
        item: {
          agentsStates: { "child-thread": { status: "running" } },
          id: "spawn",
          receiverThreadIds: ["child-thread"],
          status: "completed",
          tool: "spawnAgent",
          type: "collabAgentToolCall",
        },
        threadId: "thread-1",
      },
    });
    child.send({
      method: "item/agentMessage/delta",
      params: { delta: "private child", threadId: "child-thread" },
    });
    child.send({
      method: "turn/completed",
      params: {
        threadId: "child-thread",
        turn: { id: "child-turn", status: "completed" },
      },
    });
    child.send({
      method: "item/agentMessage/delta",
      params: { delta: "parent", threadId: "thread-1" },
    });
    child.send({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });
    expect(await result).toEqual([
      { id: "", text: "parent", type: "text-delta" },
    ]);
    expect(child.messages).toContainEqual(
      expect.objectContaining({
        method: "thread/resume",
        params: {
          excludeTurns: true,
          initialTurnsPage: { itemsView: "notLoaded", limit: 1 },
          threadId: "child-thread",
        },
      })
    );
    expect(events.at(-1)).toMatchObject({
      nativeId: "child-thread",
      status: "complete",
    });
  });
  it("observes actual monitor and cron tool results without claiming schedule controls", async () => {
    const { activities, events } = fixture();
    await activities.claudeTool({
      tool_input: { description: "Watch builds" },
      tool_name: "Monitor",
      tool_response: { persistent: true, taskId: "monitor" },
    });
    expect(events.at(-1)).toMatchObject({
      actions: ["stop"],
      kind: "watch",
      lifetime: "session",
    });
    await activities.claudeTool({
      tool_name: "CronCreate",
      tool_response: { durable: true, humanSchedule: "Every hour", id: "cron" },
    });
    expect(events.at(-1)).toMatchObject({
      kind: "schedule",
      lifetime: "sandbox",
      status: "waiting",
    });
    expect(events.at(-1)?.actions).toBeUndefined();
    await activities.claudeTool({
      tool_name: "CronDelete",
      tool_response: { id: "cron" },
    });
    expect(events.at(-1)?.status).toBe("cancelled");
  });

  it("keeps idle child observation alive and reuses process-scoped IDs on the next parent turn", async () => {
    const child = new FakeAppServer();
    const events: HarnessActivity[] = [];
    const spawn = vi.fn(async () => child);
    const driver = createCodexDriver({
      agentId: "agent",
      apiKey: "test",
      binPath: "codex",
      cwd: "/workspace",
      modelId: "gpt",
      spawn,
    });
    const input = runOptions({
      onActivity: async (activity) => {
        events.push(activity);
      },
      profile: {
        allowedTools: [],
        disallowedTools: [],
        maxSteps: 10,
        mode: "scheduled",
        unresolved: "deny",
      },
    });
    const first = await driver.run(input);
    child.send({
      method: "item/completed",
      params: {
        item: {
          agentsStates: { "child-thread": { status: "running" } },
          id: "spawn",
          receiverThreadIds: ["child-thread"],
          status: "completed",
          tool: "spawnAgent",
          type: "collabAgentToolCall",
        },
        threadId: "thread-1",
      },
    });
    child.send({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "completed" } },
    });
    await collect(first);
    const childId = events[0]?.id;
    expect(child.killed).toBe(false);
    child.send({
      method: "turn/completed",
      params: { threadId: "child-thread", turn: { status: "completed" } },
    });
    await vi.waitFor(() => expect(events.at(-1)?.status).toBe("complete"));
    const second = await driver.run(input);
    child.send({
      method: "turn/started",
      params: { threadId: "child-thread", turn: { status: "inProgress" } },
    });
    child.send({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "completed" } },
    });
    await collect(second);
    expect(events.at(-1)).toMatchObject({ id: childId, status: "running" });
    expect(spawn).toHaveBeenCalledTimes(1);
    await driver.close?.();
    expect(events.at(-1)).toMatchObject({ id: childId, status: "unknown" });
  });
  it("calls Claude native stopTask only for an observed active task and revokes it at query end", async () => {
    const events: HarnessActivity[] = [];
    const query = { stopTask: vi.fn(async () => undefined) };
    const controller = createClaudeCodeQueryController(
      query as unknown as Parameters<typeof createClaudeCodeQueryController>[0]
    );
    let settings: ClaudeCodeSettings = {};
    let finish: () => void = () => undefined;
    const model: LanguageModelV4 = {
      doGenerate: vi.fn(),
      async doStream() {
        await settings.onQueryControllerCreated?.(controller);
        await settings.onSdkMessage?.({
          description: "Watch",
          session_id: "native-session",
          subtype: "task_started",
          task_id: "native-task",
          type: "system",
          uuid: crypto.randomUUID(),
        });
        return {
          stream: new ReadableStream({
            start(stream) {
              finish = () => stream.close();
            },
          }),
        };
      },
      modelId: "sonnet",
      provider: "test",
      specificationVersion: "v4",
      supportedUrls: {},
    };
    const driver = createClaudeCodeDriver({
      agentId: "agent",
      createModel: (_, value) => {
        settings = value;
        return model;
      },
      cwd: "/workspace",
      modelId: "sonnet",
      spawnClaudeCodeProcess: vi.fn(),
    });
    const source = await driver.run(
      runOptions({
        onActivity: async (activity) => {
          events.push(activity);
        },
      })
    );
    const activityId = events[0]?.id ?? "";
    await driver.stopActivity?.(activityId);
    expect(query.stopTask).toHaveBeenCalledWith("native-task");
    expect(events.at(-1)?.status).toBe("running");
    await expect(driver.stopActivity?.("unobserved")).rejects.toThrow(
      "no longer controllable"
    );
    finish();
    await collect(source);
    expect(events.at(-1)).toMatchObject({ actions: [], status: "unknown" });
    await expect(driver.stopActivity?.(activityId)).rejects.toThrow(
      "no longer controllable"
    );
  });
  it("stops a known active Codex child turn without terminating the parent or guessing completion", async () => {
    const child = new FakeAppServer();
    const events: HarnessActivity[] = [];
    const driver = createCodexDriver({
      agentId: "agent",
      binPath: "codex",
      cwd: "/workspace",
      modelId: "gpt",
      spawn: async () => child,
    });
    const source = await driver.run(
      runOptions({
        onActivity: async (activity) => {
          events.push(activity);
        },
        profile: {
          allowedTools: [],
          disallowedTools: [],
          maxSteps: 10,
          mode: "scheduled",
          unresolved: "deny",
        },
      })
    );
    child.send({
      method: "item/completed",
      params: {
        item: {
          agentsStates: { child: { status: "running" } },
          id: "spawn",
          receiverThreadIds: ["child"],
          status: "completed",
          tool: "spawnAgent",
          type: "collabAgentToolCall",
        },
        threadId: "thread-1",
      },
    });
    await vi.waitFor(() => expect(events.at(-1)?.nativeId).toBe("child"));
    const id = events.at(-1)?.id ?? "";
    await expect(driver.stopActivity?.(id)).rejects.toThrow(
      "no controllable active turn"
    );
    child.send({
      method: "turn/started",
      params: {
        threadId: "child",
        turn: { id: "child-turn", status: "inProgress" },
      },
    });
    await vi.waitFor(() => expect(events.at(-1)?.actions).toEqual(["stop"]));
    await driver.stopActivity?.(id);
    expect(child.messages).toContainEqual(
      expect.objectContaining({
        method: "turn/interrupt",
        params: { threadId: "child", turnId: "child-turn" },
      })
    );
    expect(child.killed).toBe(false);
    expect(events.at(-1)?.status).toBe("running");
    child.send({
      method: "turn/completed",
      params: {
        threadId: "child",
        turn: { id: "child-turn", status: "interrupted" },
      },
    });
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({ actions: [], status: "waiting" })
    );
    await expect(driver.stopActivity?.(id)).rejects.toThrow(
      "no controllable active turn"
    );
    child.send({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "completed" } },
    });
    await collect(source);
    await driver.close?.();
  });

  it("attributes idle native child approvals and shared questions after the parent signal ends", async () => {
    const child = new FakeAppServer();
    const parentAbort = new AbortController();
    const approvals: HarnessPermissionRequest[] = [];
    const questions: HarnessQuestionRequest[] = [];
    const sharedQuestions: HarnessQuestionRequest[] = [];
    const driver = createCodexDriver({
      agentId: "agent",
      binPath: "codex",
      cwd: "/workspace",
      modelId: "gpt",
      spawn: async () => child,
    });
    const source = await driver.run(
      runOptions({
        permission: async (request) => {
          request.signal.throwIfAborted();
          approvals.push(request);
          return { behavior: "allow" };
        },
        profile: {
          allowedTools: [],
          disallowedTools: [],
          maxSteps: 10,
          mode: "attended",
          unresolved: "ask",
        },
        question: async (request) => {
          request.signal.throwIfAborted();
          questions.push(request);
          return { answers: { choice: ["yes"] }, outcome: "answered" };
        },
        signal: parentAbort.signal,
        tools: {
          ask_user: createHarnessQuestionTool({
            question: async (request) => {
              request.signal.throwIfAborted();
              sharedQuestions.push(request);
              return { answers: { choice: ["yes"] }, outcome: "answered" };
            },
            sessionId: "session-1",
          }),
        },
      })
    );
    child.send({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "completed" } },
    });
    await collect(source);
    parentAbort.abort();
    child.send({
      id: "approval",
      method: "item/commandExecution/requestApproval",
      params: { itemId: "command", threadId: "child" },
    });
    child.send({
      id: "native-question",
      method: "item/tool/requestUserInput",
      params: {
        itemId: "native-ask",
        questions: [{ id: "choice", question: "Continue?" }],
        threadId: "child",
      },
    });
    child.send({
      id: "shared-question",
      method: "item/tool/call",
      params: {
        arguments: { questions: [{ id: "choice", question: "Continue?" }] },
        callId: "shared-ask",
        threadId: "child",
        tool: "ask_user",
      },
    });
    await vi.waitFor(() => expect(sharedQuestions).toHaveLength(1));
    expect(approvals).toHaveLength(1);
    expect(questions).toHaveLength(1);
    expect(approvals[0]?.activityId).toBe(questions[0]?.activityId);
    expect(sharedQuestions[0]?.activityId).toBe(questions[0]?.activityId);
    expect(questions[0]?.activityId).toBeDefined();
    expect(child.killed).toBe(false);
    await driver.close?.();
  });
  it("recovers the current child turn from the subscription snapshot when its start event was missed", async () => {
    const child = new FakeAppServer();
    child.resumeResponses.set("child", {
      initialTurnsPage: {
        data: [{ id: "already-running", status: "inProgress" }],
      },
      thread: { id: "child" },
    });
    const events: HarnessActivity[] = [];
    const driver = createCodexDriver({
      agentId: "agent",
      binPath: "codex",
      cwd: "/workspace",
      modelId: "gpt",
      spawn: async () => child,
    });
    const source = await driver.run(
      runOptions({
        onActivity: async (activity) => {
          events.push(activity);
        },
        profile: {
          allowedTools: [],
          disallowedTools: [],
          maxSteps: 10,
          mode: "scheduled",
          unresolved: "deny",
        },
      })
    );
    child.send({
      method: "item/completed",
      params: {
        item: {
          agentsStates: { child: { status: "running" } },
          id: "spawn",
          receiverThreadIds: ["child"],
          status: "completed",
          tool: "spawnAgent",
          type: "collabAgentToolCall",
        },
        threadId: "thread-1",
      },
    });
    await vi.waitFor(() => expect(events.at(-1)?.actions).toEqual(["stop"]));
    await driver.stopActivity?.(events.at(-1)?.id ?? "");
    expect(child.messages).toContainEqual(
      expect.objectContaining({
        method: "turn/interrupt",
        params: { threadId: "child", turnId: "already-running" },
      })
    );
    child.send({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "completed" } },
    });
    await collect(source);
    await driver.close?.();
  });
  it("cancels a stopped child question so queued native completion cannot wedge the parent", async () => {
    const child = new FakeAppServer();
    const events: HarnessActivity[] = [];
    let asked: HarnessQuestionRequest | undefined;
    const driver = createCodexDriver({
      agentId: "agent",
      binPath: "codex",
      cwd: "/workspace",
      modelId: "gpt",
      spawn: async () => child,
    });
    const source = await driver.run(
      runOptions({
        onActivity: async (activity) => {
          events.push(activity);
        },
        profile: {
          allowedTools: [],
          disallowedTools: [],
          maxSteps: 10,
          mode: "attended",
          unresolved: "ask",
        },
        question: (request) => {
          asked = request;
          return new Promise(() => undefined);
        },
      })
    );
    child.send({
      method: "turn/started",
      params: {
        threadId: "child",
        turn: { id: "child-turn", status: "inProgress" },
      },
    });
    child.send({
      id: "child-question",
      method: "item/tool/requestUserInput",
      params: {
        itemId: "ask",
        questions: [{ id: "choice", question: "Continue?" }],
        threadId: "child",
        turnId: "child-turn",
      },
    });
    await vi.waitFor(() => expect(asked).toBeDefined());
    const id = events.at(-1)?.id ?? "";
    child.send({
      method: "turn/completed",
      params: {
        threadId: "child",
        turn: { id: "child-turn", status: "interrupted" },
      },
    });
    await driver.stopActivity?.(id);
    expect(asked?.signal.aborted).toBe(true);
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({ actions: [], status: "waiting" })
    );
    expect(child.killed).toBe(false);
    child.send({
      method: "item/agentMessage/delta",
      params: { delta: "Parent continued", threadId: "thread-1" },
    });
    child.send({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "completed" } },
    });
    expect(await collect(source)).toEqual([
      { id: "", text: "Parent continued", type: "text-delta" },
    ]);
    await driver.close?.();
  });
  it("uses confirmed Claude Agent tool result status to settle foreground children", async () => {
    const { activities, events } = fixture();
    await activities.claudeHook({
      agent_id: "agent-child",
      agent_type: "Explore",
      hook_event_name: "SubagentStart",
    });
    await activities.claudeHook({
      agent_id: "agent-child",
      agent_type: "Explore",
      hook_event_name: "SubagentStop",
    });
    expect(events.at(-1)?.status).toBe("unknown");
    await activities.claudeTool({
      agent_id: "caller",
      tool_name: "Agent",
      tool_response: { agentId: "agent-child", status: "completed" },
    });
    expect(events.at(-1)).toMatchObject({
      nativeId: "agent-child",
      parentId: activities.id("caller"),
      status: "complete",
      title: "Explore",
    });
    await activities.close();
    expect(events.at(-1)?.status).toBe("complete");
  });
  it("honors Claude native hook cancellation without cancelling the parent query", async () => {
    const hookAbort = new AbortController();
    let settings: ClaudeCodeSettings = {};
    let pending: Promise<unknown> | undefined;
    let asked: HarnessQuestionRequest | undefined;
    let parentSignal: AbortSignal | undefined;
    let finish: () => void = () => undefined;
    const model: LanguageModelV4 = {
      doGenerate: vi.fn(),
      async doStream(options) {
        parentSignal = options.abortSignal;
        pending = settings.hooks?.PreToolUse?.[0]?.hooks[0]?.(
          {
            agent_id: "native-child",
            tool_input: { questions: [{ question: "Continue?" }] },
            tool_name: "AskUserQuestion",
            tool_use_id: "ask",
          },
          "ask",
          { signal: hookAbort.signal }
        );
        return {
          stream: new ReadableStream({
            start(stream) {
              finish = () => stream.close();
            },
          }),
        };
      },
      modelId: "sonnet",
      provider: "test",
      specificationVersion: "v4",
      supportedUrls: {},
    };
    const driver = createClaudeCodeDriver({
      agentId: "agent",
      createModel: (_, value) => {
        settings = value;
        return model;
      },
      cwd: "/workspace",
      modelId: "sonnet",
      spawnClaudeCodeProcess: vi.fn(),
    });
    const source = await driver.run(
      runOptions({
        question: (request) => {
          asked = request;
          return new Promise(() => undefined);
        },
      })
    );
    await vi.waitFor(() => expect(asked).toBeDefined());
    const rejection = expect(pending).rejects.toThrow("Question canceled");
    hookAbort.abort();
    await rejection;
    expect(asked?.signal.aborted).toBe(true);
    expect(parentSignal?.aborted).toBe(false);
    expect(asked?.activityId).toBeDefined();
    finish();
    await collect(source);
  });
});
