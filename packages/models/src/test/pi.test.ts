import { jsonSchema, tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createPiDriver, type PiDriverOptions } from "../harness/pi";
import { piProvider } from "../pi";
import { collect, runOptions } from "./helpers/cli";
import { FakePi } from "./helpers/pi";

function setup(options: Partial<PiDriverOptions> = {}) {
  const child = new FakePi();
  const spawn = vi.fn<PiDriverOptions["spawn"]>(async () => child);
  const writeExtension = vi.fn(async (_source: string) => "/state/host.mjs");
  const driver = createPiDriver({
    agentId: "agent",
    binPath: "/opt/pi",
    cwd: "/workspace",
    modelId: "anthropic/test",
    spawn,
    writeExtension,
    ...options,
  });
  return { child, driver, spawn, writeExtension };
}

describe("Pi provider", () => {
  it("uses host-owned availability and the AI SDK compatibility adapter", async () => {
    const provider = piProvider();
    expect(provider.available).toBe(false);
    provider.configure?.({ available: true });
    expect(provider.available).toBe(true);
    expect(provider.harness).toBe("pi");
    expect(
      provider.languageModel("anthropic/test", { workingDirectory: "/repo" })
    ).toMatchObject({ modelId: "anthropic/test", specificationVersion: "v4" });
    await provider.dispose?.();
  });
});

describe("Pi native driver", () => {
  it("closes on malformed protocol records and withholds process diagnostics", async () => {
    const { child, driver } = setup();
    const source = await driver.run(runOptions());
    const collected = collect(source);
    child.stdout.write("invalid-secret-json\n");
    const parts = await collected;
    expect(parts).toContainEqual(expect.objectContaining({ type: "error" }));
    expect(JSON.stringify(parts)).not.toContain("secret");
    expect(child.killed).toBe(true);
  });
  it("rejects tool selection patterns before launching any process", async () => {
    const { driver, spawn } = setup({ nativeTools: ["*"] });
    await expect(driver.run(runOptions())).rejects.toThrow("known built-ins");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("recovers from a retried assistant error and withholds raw diagnostics", async () => {
    const { child, driver } = setup();
    const source = await driver.run(runOptions());
    const collected = collect(source);
    child.send({
      message: {
        errorMessage: "secret",
        role: "assistant",
        stopReason: "error",
      },
      type: "message_end",
    });
    child.send({ type: "agent_end", willRetry: true });
    child.send({
      message: { role: "assistant", stopReason: "stop" },
      type: "message_end",
    });
    child.send({ type: "agent_settled" });
    const parts = await collected;
    expect(parts).toContainEqual(expect.objectContaining({ type: "finish" }));
    expect(JSON.stringify(parts)).not.toContain("secret");
  });

  it("validates JSON-schema tools even when their AI SDK schema has no validator", async () => {
    const { child, driver } = setup();
    const execute = vi.fn();
    const source = await driver.run(
      runOptions({
        permission: async () => ({ behavior: "allow" }),
        tools: {
          read: tool({
            execute,
            inputSchema: jsonSchema({
              properties: { path: { type: "string" } },
              required: ["path"],
              type: "object",
            }),
          }),
        },
      })
    );
    const collected = collect(source);
    child.send({
      id: "tool-1",
      method: "input",
      placeholder: JSON.stringify({
        input: { path: 123 },
        toolCallId: "call-1",
        toolName: "read",
      }),
      title: "foundry.execute",
      type: "extension_ui_request",
    });
    child.send({ type: "agent_settled" });
    await collected;
    expect(execute).not.toHaveBeenCalled();
    expect(child.messages).toContainEqual(
      expect.objectContaining({
        id: "tool-1",
        value: JSON.stringify({ success: false, text: "Host tool failed" }),
      })
    );
  });
  it("uses only the host launcher and extension, resumes the native session, and waits through agent_end", async () => {
    const { child, driver, spawn, writeExtension } = setup();
    const onSessionId = vi.fn();
    const source = await driver.run(
      runOptions({ nativeSessionId: "resume-1", onSessionId })
    );
    expect(spawn.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        "--no-tools",
        "--no-mcp",
        "--no-extensions",
        "--no-context-files",
        "--session-id",
        "resume-1",
      ])
    );
    expect(writeExtension).toHaveBeenCalledOnce();
    expect(onSessionId).toHaveBeenCalledWith("native-1");
    let settled = false;
    const collected = collect(source).then((parts) => {
      settled = true;
      return parts;
    });
    child.send({
      assistantMessageEvent: {
        contentIndex: 0,
        delta: "hello\u2028world",
        type: "text_delta",
      },
      type: "message_update",
    });
    child.send({ type: "agent_end" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    child.send({
      message: {
        role: "assistant",
        stopReason: "stop",
        usage: { cacheRead: 4, cacheWrite: 5, input: 2, output: 3 },
      },
      type: "message_end",
    });
    child.send({ type: "agent_settled" });
    expect(await collected).toMatchObject([
      { text: "hello\u2028world", type: "text-delta" },
      {
        totalUsage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 },
        type: "finish",
      },
    ]);
    expect(child.killed).toBe(true);
  });

  it("checks permission before executing host tools and keeps raw arguments out of observations", async () => {
    const { child, driver } = setup();
    const execute = vi.fn(async () => "done");
    const onToolEvent = vi.fn();
    const source = await driver.run(
      runOptions({
        onToolEvent,
        tools: {
          read: tool({ execute, inputSchema: z.object({ path: z.string() }) }),
        },
      })
    );
    const collected = collect(source);
    child.send({
      id: "tool-1",
      method: "input",
      placeholder: JSON.stringify({
        input: { path: "secret" },
        toolCallId: "call-1",
        toolName: "read",
      }),
      title: "foundry.execute",
      type: "extension_ui_request",
    });
    child.send({ type: "agent_settled" });
    await collected;
    expect(execute).not.toHaveBeenCalled();
    expect(onToolEvent.mock.calls.map(([event]) => event.outcome)).toEqual([
      "started",
      "refused",
    ]);
    expect(JSON.stringify(onToolEvent.mock.calls)).not.toContain("secret");
    expect(child.messages).toContainEqual(
      expect.objectContaining({
        id: "tool-1",
        type: "extension_ui_response",
        value: JSON.stringify({ success: false, text: "Needs approval" }),
      })
    );
  });

  it("validates the approved replacement input before executing a tool", async () => {
    const { child, driver } = setup();
    const execute = vi.fn(async ({ path }: { path: string }) => path);
    const permission = vi.fn(async () => ({
      behavior: "allow" as const,
      updatedInput: { path: "approved" },
    }));
    const source = await driver.run(
      runOptions({
        permission,
        tools: {
          read: tool({ execute, inputSchema: z.object({ path: z.string() }) }),
        },
      })
    );
    const collected = collect(source);
    child.send({
      id: "tool-1",
      method: "input",
      placeholder: JSON.stringify({
        input: { path: "original" },
        toolCallId: "call-1",
        toolName: "read",
      }),
      title: "foundry.execute",
      type: "extension_ui_request",
    });
    child.send({ type: "agent_settled" });
    await collected;
    expect(execute).toHaveBeenCalledWith(
      { path: "approved" },
      expect.objectContaining({ toolCallId: "call-1" })
    );
  });

  it("enforces the turn limit and does not run queued tools after termination", async () => {
    const { child, driver } = setup();
    const execute = vi.fn();
    const source = await driver.run(
      runOptions({
        profile: {
          allowedTools: [],
          disallowedTools: [],
          maxSteps: 1,
          mode: "scheduled",
          unresolved: "deny",
        },
        tools: { read: tool({ execute, inputSchema: z.object({}) }) },
      })
    );
    const collected = collect(source);
    child.send({ type: "turn_start" });
    child.send({ type: "turn_start" });
    child.send({
      id: "tool-1",
      method: "input",
      placeholder: JSON.stringify({
        input: {},
        toolCallId: "call-1",
        toolName: "read",
      }),
      title: "foundry.execute",
      type: "extension_ui_request",
    });
    expect(await collected).toContainEqual(
      expect.objectContaining({ error: expect.any(Error), type: "error" })
    );
    expect(execute).not.toHaveBeenCalled();
    expect(child.killed).toBe(true);
  });

  it("supports live steering and closes a canceled turn", async () => {
    const { child, driver } = setup();
    const source = await driver.run(runOptions());
    const collected = collect(source);
    await driver.steer?.("next instruction");
    expect(child.messages).toContainEqual(
      expect.objectContaining({ message: "next instruction", type: "steer" })
    );
    await driver.interrupt?.();
    expect(await collected).toContainEqual(
      expect.objectContaining({ type: "abort" })
    );
    expect(child.killed).toBe(true);
  });
});
