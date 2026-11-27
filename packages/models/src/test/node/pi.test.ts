import type {
  Capability,
  HarnessPermissionRequest,
} from "@foundry/core/agents";
import { jsonSchema, tool } from "ai";
import type { PiSettings } from "ai-sdk-provider-pi";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import { type PiProviderConfig, piProvider } from "../../providers/pi";
import {
  createPiDriver,
  type PiDriverOptions,
} from "../../providers/pi/driver";
import { piExtension } from "../../providers/pi/tools";
import { collect, runOptions } from "../helpers/fake-app-server";
import { FakePi } from "../helpers/fake-pi";

const TOOL_META = Symbol.for("foundry.tool-meta");

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
  it("declares the Pi SDK's settings as its default settings", () => {
    expectTypeOf<
      NonNullable<PiProviderConfig["defaultSettings"]>
    >().toEqualTypeOf<PiSettings>();
  });

  it("uses host-owned availability and the AI SDK compatibility adapter", async () => {
    expect(piProvider().available).toBe(false);
    const provider = piProvider({ config: { available: true } });
    expect(provider.available).toBe(true);
    expect(provider.turnLimit).toBe("unsupported");
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

  it("forwards tool capability metadata on host tool permission requests", async () => {
    const { child, driver } = setup();
    const requests: HarnessPermissionRequest[] = [];
    const capability: Capability = {
      kind: "mcp.tool",
      serverId: "linear",
      tool: "list_issues",
    };
    const taggedTool = Object.assign(
      tool({
        execute: async () => "issues",
        inputSchema: z.object({ team: z.string() }),
      }),
      {
        [TOOL_META]: {
          capability: () => capability,
          source: "mcp" as const,
        },
      }
    );
    const source = await driver.run(
      runOptions({
        permission: async (request) => {
          requests.push(request);
          return { behavior: "allow" };
        },
        tools: { linear__list_issues: taggedTool },
      })
    );
    const collected = collect(source);
    child.send({
      id: "tool-meta-1",
      method: "input",
      placeholder: JSON.stringify({
        input: { team: "ENG" },
        toolCallId: "call-meta-1",
        toolName: "linear__list_issues",
      }),
      title: "foundry.execute",
      type: "extension_ui_request",
    });
    child.send({ type: "agent_settled" });
    await collected;
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      capability,
      source: "mcp",
      toolCallId: "call-meta-1",
      toolName: "linear__list_issues",
    });
  });

  it("fails closed on unknown tool names in piExtension and host permission handling", async () => {
    const sourceCode = piExtension(
      [{ description: "Host read", name: "host_read", parameters: {} }],
      "anthropic",
      undefined,
      ["read"]
    );
    const factory = new Function(
      `${sourceCode.replace("export default ", "return ")}`
    )() as (pi: {
      on: (
        event: string,
        handler: (
          event: { input: unknown; toolCallId: string; toolName: string },
          ctx: {
            signal: AbortSignal;
            ui: {
              input: (title: string, placeholder: string) => Promise<string>;
            };
          }
        ) => Promise<unknown>
      ) => void;
      registerProvider: () => void;
      registerTool: () => void;
    }) => void;
    let onToolCall:
      | ((
          event: { input: unknown; toolCallId: string; toolName: string },
          ctx: {
            signal: AbortSignal;
            ui: {
              input: (title: string, placeholder: string) => Promise<string>;
            };
          }
        ) => Promise<unknown>)
      | undefined;
    factory({
      on(event, handler) {
        if (event === "tool_call") {
          onToolCall = handler;
        }
      },
      registerProvider: vi.fn(),
      registerTool: vi.fn(),
    });
    const uiInput = vi.fn(async () =>
      JSON.stringify({ success: true, text: "ok" })
    );
    const ctx = {
      signal: new AbortController().signal,
      ui: { input: uiInput },
    };

    // Unknown tool fails closed without invoking UI permission.
    expect(
      await onToolCall?.(
        { input: { cmd: "rm -rf /" }, toolCallId: "c1", toolName: "bash" },
        ctx
      )
    ).toEqual({ block: true, reason: "Unknown Pi tool" });
    expect(uiInput).not.toHaveBeenCalled();

    // Registered host tool delegates to execute(), not native permission.
    expect(
      await onToolCall?.(
        { input: {}, toolCallId: "c2", toolName: "host_read" },
        ctx
      )
    ).toBeUndefined();
    expect(uiInput).not.toHaveBeenCalled();

    // Declared native tool routes through foundry.permission.
    expect(
      await onToolCall?.(
        { input: { path: "README.md" }, toolCallId: "c3", toolName: "read" },
        ctx
      )
    ).toBeUndefined();
    expect(uiInput).toHaveBeenCalledWith(
      "foundry.permission",
      expect.stringContaining('"toolName":"read"'),
      expect.any(Object)
    );

    // Host-side foundry.permission also refuses undeclared native tools.
    const { child, driver } = setup({ nativeTools: ["read"] });
    const permission = vi.fn(async () => ({ behavior: "allow" as const }));
    const stream = await driver.run(runOptions({ permission }));
    const collected = collect(stream);
    child.send({
      id: "perm-unknown",
      method: "input",
      placeholder: JSON.stringify({
        input: { command: "id" },
        toolCallId: "call-unknown",
        toolName: "bash",
      }),
      title: "foundry.permission",
      type: "extension_ui_request",
    });
    child.send({ type: "agent_settled" });
    await collected;
    expect(permission).not.toHaveBeenCalled();
    expect(child.messages).toContainEqual(
      expect.objectContaining({
        id: "perm-unknown",
        value: JSON.stringify({ success: false, text: "Unknown Pi tool" }),
      })
    );
  });
});
