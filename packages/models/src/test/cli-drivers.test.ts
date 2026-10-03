import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type {
  HarnessToolEvent,
  HarnessTurnDriver,
} from "@foundry/agents/harness";
import { tool } from "ai";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createClaudeCodeDriver } from "../harness/claude-code";
import { createCodexDriver } from "../harness/codex";

type Run = Parameters<HarnessTurnDriver["run"]>[0];

function runOptions(patch: Partial<Run> = {}): Run {
  return {
    input: "new input only",
    onSessionId: async () => undefined,
    onToolEvent: async () => undefined,
    permission: async () => ({ behavior: "deny", message: "Needs approval" }),
    profile: {
      allowedTools: ["Read"],
      disallowedTools: ["Bash(git push*)"],
      maxSteps: 4,
      mode: "scheduled",
      unresolved: "deny",
    },
    sessionId: "session-1",
    signal: new AbortController().signal,
    ...patch,
  };
}

class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly messages: Record<string, unknown>[] = [];
  killed = false;
  private buffer = "";

  constructor() {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        const message = JSON.parse(line) as Record<string, unknown>;
        this.messages.push(message);
        if (message.method === "initialize") {
          this.send({ id: message.id, result: {} });
        }
        if (message.method === "account/login/start") {
          this.send({ id: message.id, result: {} });
        }
        if (
          message.method === "thread/start" ||
          message.method === "thread/resume"
        ) {
          this.send({ id: message.id, result: { thread: { id: "thread-1" } } });
        }
        if (message.method === "turn/start") {
          this.send({
            id: message.id,
            result: { turn: { id: "turn-1", status: "inProgress" } },
          });
        }
        if (
          message.method === "turn/interrupt" ||
          message.method === "turn/steer"
        ) {
          this.send({ id: message.id, result: {} });
        }
      }
    });
  }
  send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

async function collect(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const result: unknown[] = [];
  for await (const value of source) {
    result.push(value);
  }
  return result;
}

describe("Claude Code native driver", () => {
  it("sets per-session permission settings, records hooks and refusals, and resumes without replaying history", async () => {
    let settings: ClaudeCodeSettings = {};
    let prompt: unknown;
    const events: HarnessToolEvent[] = [];
    const model: LanguageModelV4 = {
      doGenerate: vi.fn(),
      async doStream(options) {
        ({ prompt } = options);
        await settings.hooks?.PreToolUse?.[0]?.hooks[0]?.({
          tool_input: { command: "TOKEN=secret git push" },
          tool_name: "Bash",
          tool_use_id: "tool-1",
        });
        await settings.canUseTool?.(
          "Bash",
          { command: "TOKEN=secret git push" },
          {
            requestId: "request-1",
            signal: options.abortSignal ?? new AbortController().signal,
            toolUseID: "tool-1",
          }
        );
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                delta: "done",
                id: "text-1",
                type: "text-delta",
              });
              controller.enqueue({
                input: "TOKEN=secret",
                toolCallId: "tool-1",
                toolName: "Bash",
                type: "tool-call",
              });
              controller.close();
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
      agentId: "agent-1",
      createModel: (_, value) => {
        settings = value;
        return model;
      },
      cwd: "/workspace",
      modelId: "sonnet",
      settings: {
        permissionMode: "bypassPermissions",
        sdkOptions: { permissionMode: "bypassPermissions" },
      },
      spawnClaudeCodeProcess: vi.fn(),
    });
    const stream = await driver.run(
      runOptions({
        nativeSessionId: "native-1",
        onToolEvent: async (event) => {
          events.push(event);
        },
      })
    );
    expect(await collect(stream)).toEqual([
      { delta: "done", id: "text-1", type: "text-delta" },
    ]);
    expect(settings).toMatchObject({
      allowedTools: ["Read"],
      disallowedTools: ["Bash(git push*)"],
      maxTurns: 4,
      permissionMode: "dontAsk",
      resume: "native-1",
      settingSources: [],
    });
    expect(settings.sdkOptions).toBeUndefined();
    expect(prompt).toEqual([
      { content: [{ text: "new input only", type: "text" }], role: "user" },
    ]);
    expect(events.map((event) => event.outcome)).toEqual([
      "started",
      "refused",
    ]);
    expect(JSON.stringify(events)).not.toContain("secret");
  });
});

describe("Codex native app-server driver", () => {
  it("fails before launch for an unenforceable deny rule", async () => {
    const spawn = vi.fn(async () => new FakeAppServer());
    const driver = createCodexDriver({
      agentId: "agent-1",
      binPath: "/opt/codex",
      cwd: "/workspace",
      modelId: "model-1",
      spawn,
    });
    await expect(driver.run(runOptions())).rejects.toThrow(
      "cannot enforce deny rule Bash(git push*)"
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("uses read-only native policy for the default scheduled read profile", async () => {
    const child = new FakeAppServer();
    const driver = createCodexDriver({
      agentId: "agent-1",
      binPath: "/opt/codex",
      cwd: "/workspace",
      modelId: "model-1",
      spawn: async () => child,
    });
    const stream = await driver.run(
      runOptions({ profile: { ...runOptions().profile, disallowedTools: [] } })
    );
    expect(
      child.messages.find((message) => message.method === "thread/start")
        ?.params
    ).toMatchObject({
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "read-only",
    });
    child.send({
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });
    await collect(stream);
  });

  it("uses subscription tokens ahead of API credentials and keeps refresh on the host", async () => {
    const child = new FakeAppServer();
    const refresh = vi.fn(async () => ({
      accessToken: "new-access-token",
      chatgptAccountId: "account-1",
    }));
    const driver = createCodexDriver({
      agentId: "agent-1",
      apiKey: "unused-api-key",
      binPath: "/opt/codex",
      chatgptAuthTokens: {
        accessToken: "subscription-access-token",
        chatgptAccountId: "account-1",
      },
      cwd: "/workspace",
      modelId: "model-1",
      refreshChatgptAuthTokens: refresh,
      spawn: async () => child,
    });
    const stream = await driver.run(
      runOptions({ profile: { ...runOptions().profile, disallowedTools: [] } })
    );
    expect(
      child.messages.find((message) => message.method === "account/login/start")
        ?.params
    ).toEqual({
      accessToken: "subscription-access-token",
      chatgptAccountId: "account-1",
      type: "chatgptAuthTokens",
    });
    child.send({
      id: 99,
      method: "account/chatgptAuthTokens/refresh",
      params: { previousAccountId: "account-1", reason: "unauthorized" },
    });
    child.send({
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });
    await collect(stream);
    expect(refresh).toHaveBeenCalledOnce();
    expect(child.messages.find((message) => message.id === 99)).toEqual({
      id: 99,
      result: {
        accessToken: "new-access-token",
        chatgptAccountId: "account-1",
      },
    });
    expect(JSON.stringify(child.messages)).not.toContain("unused-api-key");
  });

  it("validates and executes dynamic tools on the host after authority allows them", async () => {
    const child = new FakeAppServer();
    const execute = vi.fn(
      async (input: { value: string }) => `host:${input.value}`
    );
    const events: HarnessToolEvent[] = [];
    const driver = createCodexDriver({
      agentId: "agent-1",
      binPath: "/opt/codex",
      cwd: "/workspace",
      modelId: "model-1",
      spawn: async () => child,
    });
    const stream = await driver.run(
      runOptions({
        onToolEvent: async (event) => {
          events.push(event);
        },
        permission: async () => ({ behavior: "allow" }),
        profile: { ...runOptions().profile, disallowedTools: [] },
        tools: {
          host_probe: tool({
            execute,
            inputSchema: z.object({ value: z.string() }),
          }),
        },
      })
    );
    child.send({
      id: 91,
      method: "item/tool/call",
      params: {
        arguments: { value: "ok" },
        callId: "call-1",
        tool: "host_probe",
      },
    });
    child.send({
      id: 92,
      method: "item/tool/call",
      params: {
        arguments: { value: 42 },
        callId: "call-2",
        tool: "host_probe",
      },
    });
    child.send({
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });
    await collect(stream);
    expect(execute).toHaveBeenCalledOnce();
    expect(child.messages.find((message) => message.id === 91)).toEqual({
      id: 91,
      result: {
        contentItems: [{ text: "host:ok", type: "inputText" }],
        success: true,
      },
    });
    expect(
      child.messages.find((message) => message.id === 92)?.result
    ).toMatchObject({ success: false });
    expect(events.map((event) => event.outcome)).toEqual([
      "started",
      "ran",
      "started",
      "failed",
    ]);
    const threadStart = child.messages.find(
      (message) => message.method === "thread/start"
    )?.params as Record<string, unknown>;
    expect(threadStart.dynamicTools).toMatchObject([
      { name: "host_probe", type: "function" },
    ]);
  });

  it("handshakes, explicitly sets posture, routes approvals, records outcomes, and closes its guest", async () => {
    const child = new FakeAppServer();
    const events: HarnessToolEvent[] = [];
    const permission = vi.fn(async () => ({
      behavior: "deny" as const,
      message: "Needs approval",
    }));
    const driver = createCodexDriver({
      agentId: "agent-1",
      binPath: "/opt/codex",
      cwd: "/workspace",
      instructions: "Follow the agent instructions",
      modelId: "model-1",
      spawn: async () => child,
    });
    const stream = await driver.run(
      runOptions({
        onToolEvent: async (event) => {
          events.push(event);
        },
        permission,
        profile: {
          ...runOptions().profile,
          allowedTools: ["Edit"],
          disallowedTools: [],
        },
      })
    );
    child.send({
      method: "item/started",
      params: {
        item: {
          command: "TOKEN=secret git push",
          id: "tool-1",
          type: "commandExecution",
        },
      },
    });
    child.send({
      id: 99,
      method: "item/commandExecution/requestApproval",
      params: { command: "TOKEN=secret git push", itemId: "tool-1" },
    });
    child.send({
      method: "item/completed",
      params: {
        item: { id: "tool-1", status: "declined", type: "commandExecution" },
      },
    });
    child.send({
      method: "item/agentMessage/delta",
      params: { delta: "done" },
    });
    child.send({
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed" } },
    });
    expect(await collect(stream)).toEqual([
      { delta: "done", type: "text-delta" },
    ]);
    expect(child.messages.map((message) => message.method).slice(0, 4)).toEqual(
      ["initialize", "initialized", "thread/start", "turn/start"]
    );
    expect(
      child.messages.find((message) => message.method === "thread/start")
        ?.params
    ).toMatchObject({
      approvalPolicy: "untrusted",
      developerInstructions: "Follow the agent instructions",
      sandbox: "workspace-write",
    });
    expect(child.messages.find((message) => message.id === 99)).toEqual({
      id: 99,
      result: { decision: "decline" },
    });
    expect(events.map((event) => event.outcome)).toEqual([
      "started",
      "refused",
    ]);
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(child.killed).toBe(true);
  });

  it("resumes the durable native thread, sends only new input, and rejects pending work on abort", async () => {
    const child = new FakeAppServer();
    const abort = new AbortController();
    const driver = createCodexDriver({
      agentId: "agent-1",
      binPath: "/opt/codex",
      cwd: "/workspace",
      modelId: "model-1",
      spawn: async () => child,
    });
    const stream = await driver.run(
      runOptions({
        nativeSessionId: "thread-1",
        profile: { ...runOptions().profile, disallowedTools: [] },
        signal: abort.signal,
      })
    );
    expect(
      child.messages.find((message) => message.method === "thread/resume")
        ?.params
    ).toMatchObject({ threadId: "thread-1" });
    expect(
      child.messages.find((message) => message.method === "turn/start")?.params
    ).toMatchObject({
      input: [{ text: "new input only", text_elements: [], type: "text" }],
    });
    abort.abort();
    const parts = await collect(stream);
    expect(parts).toHaveLength(1);
    expect(child.killed).toBe(true);
  });
});
