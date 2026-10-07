import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import {
  agentSubject,
  createInMemoryAgentAuthorizer,
} from "@foundry/agents/authorization";
import { resolveHarnessApproval } from "@foundry/agents/harness";
import { InMemorySessionStore } from "@foundry/agents/session";
import type { Container } from "@foundry/sandbox/container/containers";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import type { SandboxSessionOptions } from "../../src/lib/sandbox/session";
import { createSandboxSession } from "../../src/lib/sandbox/session";
import type { Sandbox } from "../../src/lib/types";

/** The container the last `guest()` built; a session opens over it. */
const binding: { container: Container | undefined } = { container: undefined };
vi.mock("@foundry/models/claude-code", () => ({
  createClaudeCodeDriver: () => {
    throw new Error("CLI not expected");
  },
}));
vi.mock("@foundry/models/codex", () => ({
  createCodexDriver: () => {
    throw new Error("CLI not expected");
  },
}));

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 0, total: 0 },
  outputTokens: { reasoning: 0, text: 0, total: 0 },
};

function model(calls: { name: string; input: unknown }[]) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const call = calls[step];
      step += 1;
      return {
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks: call
            ? [
                {
                  input: JSON.stringify(call.input),
                  toolCallId: `call-${step}`,
                  toolName: call.name,
                  type: "tool-call",
                },
                {
                  finishReason: { raw: undefined, unified: "tool-calls" },
                  type: "finish",
                  usage,
                },
              ]
            : [
                { id: "answer", type: "text-start" },
                { delta: "done", id: "answer", type: "text-delta" },
                { id: "answer", type: "text-end" },
                {
                  finishReason: { raw: undefined, unified: "stop" },
                  type: "finish",
                  usage,
                },
              ],
        }),
      };
    },
  });
}

function guest() {
  const files = new Map<string, string>([["/workspace/a.ts", "const x = 1;"]]);
  const writeFile = vi.fn(
    async (path: string, content: string | Uint8Array) => {
      files.set(
        path,
        typeof content === "string"
          ? content
          : new TextDecoder().decode(content)
      );
    }
  );
  const exec = vi.fn(async (command: string | readonly string[]) => {
    if (typeof command !== "string" && command[0] === "test") {
      return { exitCode: 1, stderr: "", stdout: "" };
    }
    return { exitCode: 0, stderr: "", stdout: "tests passed" };
  });
  const container = {
    commands: { exec },
    files: {
      isDirectory: async (path: string) => path === "/workspace",
      list: async () =>
        [...files.keys()].map((path) => ({ path, type: "file" })),
      readFile: async (path: string) => {
        const text = files.get(path);
        if (text === undefined) {
          throw new Error("Missing file");
        }
        return new TextEncoder().encode(text);
      },
      realpath: async (path: string) => {
        if (path === "/workspace" || files.has(path)) {
          return path;
        }
        throw new Error("Missing file");
      },
      writeFile,
    },
    workingDirectory: "/workspace",
  } as unknown as Container;
  binding.container = container;
  return { exec, files, writeFile };
}

const sandbox = {} as Sandbox;
const { signal } = new AbortController();

async function session(
  network: MockLanguageModelV4,
  overrides: Partial<SandboxSessionOptions> = {},
  context: {
    store?: InMemorySessionStore;
    signal?: AbortSignal;
    write?: (value: unknown) => void;
  } = {}
) {
  if (!binding.container) {
    throw new Error("call guest() before opening a session");
  }
  return createSandboxSession({
    agentId: "coder",
    container: binding.container,
    harness: "builtin",
    instructions: "Make one change and run tests.",
    model: network,
    modelId: "gateway-model",
    options: {
      authority: { policy: createInMemoryAgentAuthorizer().authorizer },
      sandbox,
      ...overrides,
    },
    provider: "gateway",
    sessionId: "session",
    signal: context.signal ?? signal,
    store: context.store ?? new InMemorySessionStore(),
    write: context.write ?? (() => undefined),
  });
}

describe("built-in sandbox session factory", () => {
  it.each(["disabled", "default", "enabled", "custom"] as const)(
    "honours %s compaction for over-budget retained history",
    async (mode) => {
      guest();
      const store = new InMemorySessionStore();
      await store.createSession({ id: "session" });
      for (const role of ["user", "assistant"] as const) {
        await store.appendMessage({
          parts: [{ text: "history ".repeat(1000), type: "text" }],
          role,
          sessionId: "session",
        });
      }
      const network = Object.assign(model([]), {
        limits: { contextWindow: 100, maxOutputTokens: 0 },
      });
      const generate = vi.spyOn(network, "doGenerate").mockResolvedValue({
        content: [{ text: "retained summary", type: "text" }],
        finishReason: { raw: undefined, unified: "stop" },
        usage,
        warnings: [],
      });
      const summarize = vi.fn(async () => "custom summary");
      const options: Record<typeof mode, Partial<SandboxSessionOptions>> = {
        custom: { compaction: { keepTokens: 1, summarizer: { summarize } } },
        default: {},
        disabled: { compaction: false },
        enabled: { compaction: true },
      };
      const harness = await session(network, options[mode], { store });
      try {
        expect((await harness.generate("continue")).status).toBe("complete");
        const summaries = (await store.listMessages("session")).filter(
          (message) => message.role === "summary"
        );
        expect(summaries).toHaveLength(mode === "disabled" ? 0 : 1);
        expect(generate).toHaveBeenCalledTimes(
          mode === "default" || mode === "enabled" ? 1 : 0
        );
        expect(summarize).toHaveBeenCalledTimes(mode === "custom" ? 1 : 0);
      } finally {
        await harness.close?.();
      }
    }
  );

  it.each([true, false, {}] as const)(
    "rejects native CLI compaction option %j before preparing the guest",
    async (compaction) => {
      guest();
      if (!binding.container) {
        throw new Error("expected guest");
      }
      await expect(
        createSandboxSession({
          agentId: "coder",
          container: binding.container,
          harness: "claude-code",
          instructions: "inspect",
          modelId: "sonnet",
          options: {
            authority: { policy: createInMemoryAgentAuthorizer().authorizer },
            compaction,
            sandbox,
          },
          provider: "claude-code",
          sessionId: "session",
          signal,
          store: new InMemorySessionStore(),
          write: () => undefined,
        })
      ).rejects.toThrow("manage their own compaction");
    }
  );

  it("runs a gateway tool loop over guest files and commands with one grant claim per effect", async () => {
    const fake = guest();
    const authority = createInMemoryAgentAuthorizer();
    for (const tool of ["write", "bash"]) {
      await authority.allow(agentSubject("coder"), {
        kind: "tool.call",
        source: "builtin",
        tool,
      });
    }
    const claim = vi.spyOn(authority.authorizer, "claim");
    const harness = await session(
      model([
        {
          input: { content: "const x = 2;", file_path: "a.ts" },
          name: "write",
        },
        { input: { command: "bun test" }, name: "bash" },
      ]),
      { authority: { policy: authority.authorizer } }
    );
    const reply = await harness.generate("edit and check");
    expect(reply.status).toBe("complete");
    expect(fake.files.get("/workspace/a.ts")).toBe("const x = 2;");
    expect(fake.exec).toHaveBeenCalledWith(
      "bun test",
      expect.objectContaining({ cwd: "/workspace" })
    );
    expect(claim).toHaveBeenCalledTimes(2);
    expect(
      reply.parts.filter((part) => part.type === "tool_result")
    ).toHaveLength(2);
  });

  it("enforces static scoped refusals even when the custom authority allows everything", async () => {
    const fake = guest();
    const authority = createInMemoryAgentAuthorizer({
      policy: { byKind: { "tool.call": "allow" }, global: "allow" },
    });
    const claim = vi.spyOn(authority.authorizer, "claim");
    const harness = await session(
      model([
        {
          input: { command: "git push https://example.test/repo" },
          name: "bash",
        },
      ]),
      {
        authority: { policy: authority.authorizer },
        profile: {
          allowedTools: ["bash"],
          disallowedTools: ["Bash(git push*)"],
          maxSteps: 8,
          mode: "scheduled",
          unresolved: "deny",
        },
      }
    );
    const reply = await harness.generate("publish");
    expect(fake.exec).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(reply.parts).toContainEqual({
      output: { approved: false, reason: "Denied by harness profile." },
      toolCallId: "call-1",
      type: "tool_result",
    });
  });

  it("waits for an attended approval, executes once, and remembers the grant", async () => {
    const fake = guest();
    const authority = createInMemoryAgentAuthorizer();
    const store = new InMemorySessionStore();
    const onApprovalRequest = vi.fn();
    const write = vi.fn();
    let answer!: (value: { approved: boolean; lifetime: "persistent" }) => void;
    const approve = vi.fn(
      () =>
        new Promise<{ approved: boolean; lifetime: "persistent" }>(
          (resolve) => {
            answer = resolve;
          }
        )
    );
    const profile = {
      allowedTools: [],
      disallowedTools: [],
      maxSteps: 8,
      mode: "attended" as const,
      unresolved: "ask" as const,
    };
    const options = {
      authority: { approve, onApprovalRequest, policy: authority.authorizer },
      profile,
    };
    const claim = vi.spyOn(authority.authorizer, "claim");
    const harness = await session(
      model([{ input: { command: "bun test" }, name: "bash" }]),
      options,
      { store, write }
    );
    const pending = harness.generate("check");
    await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
    expect(fake.exec).not.toHaveBeenCalled();
    expect(onApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "coder",
        capability: { kind: "tool.call", source: "builtin", tool: "bash" },
        sessionId: "session",
      })
    );
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ type: "harness-approval" })
    );
    answer({ approved: true, lifetime: "persistent" });
    const reply = await pending;
    expect(reply.status).toBe("complete");
    expect(fake.exec).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenCalledOnce();
    const nextModel = model([{ input: { command: "bun test" }, name: "bash" }]);
    const reopened = await session(nextModel, options, { store });
    await reopened.generate("check again");
    expect(approve).toHaveBeenCalledOnce();
    expect(fake.exec).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(nextModel.doStreamCalls[0]?.prompt)).not.toContain(
      "tool-approval-request"
    );
  });

  it("scheduled asks refuse the effect and a deferred grant enables a later run", async () => {
    const fake = guest();
    const authority = createInMemoryAgentAuthorizer();
    const store = new InMemorySessionStore();
    const approve = vi.fn(() => new Promise<never>(() => undefined));
    const options = { authority: { approve, policy: authority.authorizer } };
    const harness = await session(
      model([{ input: { command: "bun test" }, name: "bash" }]),
      options,
      { store }
    );
    const turn = harness.stream("check");
    const reply = await turn.message;
    expect(await turn.outcome).toBe("complete");
    expect(reply.parts).toContainEqual({
      output: {
        approved: false,
        reason:
          "Needs approval: bash. The request was recorded for a future run.",
      },
      toolCallId: "call-1",
      type: "tool_result",
    });
    expect(fake.exec).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
    const request = (await store.listMessages("session"))
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool_approval_request");
    expect(request).toMatchObject({ approvalMode: "deferred" });
    if (request?.type !== "tool_approval_request") {
      throw new Error("Missing request");
    }
    await resolveHarnessApproval(
      { agentId: "coder", policy: authority.authorizer, store },
      "session",
      request.approvalId,
      { approved: true, lifetime: "persistent" }
    );
    const nextModel = model([{ input: { command: "bun test" }, name: "bash" }]);
    const next = await session(nextModel, options, { store });
    await next.generate("check again");
    expect(fake.exec).toHaveBeenCalledOnce();
    expect(JSON.stringify(nextModel.doStreamCalls[0]?.prompt)).not.toContain(
      "tool-approval-request"
    );
  });

  it("aborts a pending attended approval without executing or granting", async () => {
    const fake = guest();
    const authority = createInMemoryAgentAuthorizer();
    const controller = new AbortController();
    const approve = vi.fn(() => new Promise<never>(() => undefined));
    const harness = await session(
      model([{ input: { command: "bun test" }, name: "bash" }]),
      {
        authority: { approve, policy: authority.authorizer },
        profile: {
          allowedTools: [],
          disallowedTools: [],
          maxSteps: 8,
          mode: "attended",
          unresolved: "ask",
        },
      }
    );
    const pending = harness.generate("check", { signal: controller.signal });
    await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
    controller.abort(new Error("cancelled approval"));
    await pending;
    expect(fake.exec).not.toHaveBeenCalled();
    expect(
      await authority.authorizer.decide({
        capability: { kind: "tool.call", source: "builtin", tool: "bash" },
        invocationId: "another-call",
        subject: agentSubject("coder"),
      })
    ).toEqual({ kind: "requires-approval" });
  });

  it("allows lower-case read tools under the scheduled default", async () => {
    const fake = guest();
    const harness = await session(
      model([{ input: { file_path: "a.ts" }, name: "read" }])
    );
    expect((await harness.generate("inspect")).parts).toContainEqual({
      output: "     1\tconst x = 1;",
      toolCallId: "call-1",
      type: "tool_result",
    });
    expect(fake.writeFile).not.toHaveBeenCalled();
  });
});
