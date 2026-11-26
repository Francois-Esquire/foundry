import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type {
  ClaudeCodeLanguageModel,
  ClaudeCodeSettings,
} from "ai-sdk-provider-claude-code";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { claudeCodeCallCost } from "../../cost";
import { Models } from "../../models";
import type { ClaudeCodeProviderConfig } from "../../providers/claude-code";
import { spawnRecordedCli } from "../../providers/claude-code/spawn";

const VERSION_DIGIT_PATTERN = /\d/;

const languageModel = vi.fn((modelId: string) => ({ modelId }));
const createClaudeCode = vi.fn(() => ({ languageModel }));
const startup = vi.fn();

vi.mock("ai-sdk-provider-claude-code", () => ({ createClaudeCode, startup }));

const { CLAUDE_CODE_DEFAULT_MODELS, claudeCodeModels, claudeCodeProvider } =
  await import("../../providers/claude-code");
const claudeCodeSdk = await vi.importActual<
  typeof import("ai-sdk-provider-claude-code")
>("ai-sdk-provider-claude-code");

const env = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined
  )
);

afterEach(() => {
  vi.unstubAllEnvs();
  startup.mockReset();
});

describe("claudeCodeModels", () => {
  it("asks the scoped CLI for models without yielding a prompt and preserves aliases and canonical IDs", async () => {
    let promptRead: Promise<IteratorResult<unknown>> | undefined;
    const closeQuery = vi.fn();
    const closeWarm = vi.fn();
    const query = vi.fn((prompt: AsyncIterable<unknown>) => {
      promptRead = prompt[Symbol.asyncIterator]().next();
      return {
        close: closeQuery,
        supportedModels: () =>
          Promise.resolve([
            {
              displayName: "Sonnet",
              resolvedModel: "claude-sonnet-5",
              value: "sonnet",
            },
            {
              displayName: "Default",
              resolvedModel: "claude-opus-5-5",
              value: "default",
            },
            {
              displayName: "Opus variant",
              resolvedModel: "claude-opus-5-5",
              value: "opus[1m]",
            },
            { displayName: "Canonical Sonnet", value: "claude-sonnet-5" },
          ]),
      };
    });
    startup.mockResolvedValue({ close: closeWarm, query });
    vi.stubEnv("ANTHROPIC_API_KEY", "ambient-key");
    const rows = await claudeCodeModels({
      binPath: "/tools/claude",
      env: { CLAUDE_CONFIG_DIR: "/account", HOME: "/account-home" },
    });
    expect(rows.map(({ id, modelId }) => [id, modelId])).toEqual([
      ["default", "default"],
      ["sonnet", "sonnet"],
      ["opus[1m]", "opus[1m]"],
      ["claude-sonnet-5", "claude-sonnet-5"],
      ["claude-opus-5-5", "claude-opus-5-5"],
    ]);
    expect(rows.find(({ id }) => id === "claude-sonnet-5")?.label).toBe(
      "Canonical Sonnet"
    );
    expect(rows.every((row) => row.limits === undefined)).toBe(true);
    expect(startup.mock.calls[0]?.[0]).toMatchObject({
      initializeTimeoutMs: 4000,
      options: {
        allowedTools: [],
        env: {
          ANTHROPIC_API_KEY: undefined,
          CLAUDE_CONFIG_DIR: "/account",
          HOME: "/account-home",
        },
        mcpServers: {},
        pathToClaudeCodeExecutable: "/tools/claude",
        permissionMode: "dontAsk",
        persistSession: false,
        settingSources: [],
        settings: { disableAllHooks: true },
        spawnClaudeCodeProcess: spawnRecordedCli,
        strictMcpConfig: true,
        tools: [],
      },
    });
    expect(await promptRead).toEqual({ done: true, value: undefined });
    expect(closeQuery).toHaveBeenCalledOnce();
    expect(closeWarm).toHaveBeenCalledOnce();
  });

  it("closes both handles on discovery failure and keeps SDK diagnostics out of the message", async () => {
    const closeQuery = vi.fn();
    const closeWarm = vi.fn();
    startup.mockResolvedValue({
      close: closeWarm,
      query: () => ({
        close: closeQuery,
        supportedModels: () =>
          Promise.reject(new Error("private SDK diagnostic")),
      }),
    });
    await expect(
      claudeCodeModels({ binPath: "/tools/claude", env })
    ).rejects.toMatchObject({
      message: "Claude Code SDK could not list models",
    });
    expect(closeQuery).toHaveBeenCalledOnce();
    expect(closeWarm).toHaveBeenCalledOnce();
  });
});

describe("claudeCodeProvider", () => {
  it("starts with no catalog when none is supplied", () => {
    expect(claudeCodeProvider({ env }).models).toEqual([]);
  });

  it("is unavailable until the host says otherwise", () => {
    expect(claudeCodeProvider({ env }).available).toBe(false);
  });

  it("is available when the host says so", () => {
    expect(
      claudeCodeProvider({ config: { available: true }, env }).available
    ).toBe(true);
  });

  it("enforces a turn limit natively", () => {
    expect(claudeCodeProvider({ env }).turnLimit).toBe("native");
  });

  it("mounts a turn-scoped working directory when it builds the model", async () => {
    const model = claudeCodeProvider({ env }).languageModel("sonnet", {
      workingDirectory: "/repo",
    });
    await model.supportedUrls;
    expect(languageModel).toHaveBeenLastCalledWith("sonnet", {
      cwd: "/repo",
      env: {},
      spawnClaudeCodeProcess: spawnRecordedCli,
    });
  });

  it("passes a native turn limit to Claude Code", async () => {
    const model = claudeCodeProvider({ env }).languageModel("sonnet", {
      nativeMaxTurns: 7,
      workingDirectory: "/repo",
    });
    await model.supportedUrls;
    expect(languageModel).toHaveBeenLastCalledWith("sonnet", {
      cwd: "/repo",
      env: {},
      maxTurns: 7,
      spawnClaudeCodeProcess: spawnRecordedCli,
    });
  });

  it("offers only family aliases, never a pinned version", () => {
    for (const model of CLAUDE_CODE_DEFAULT_MODELS) {
      expect(model.id).toBe(model.modelId);
      expect(model.id).not.toMatch(VERSION_DIGIT_PATTERN);
    }
  });

  it("declares every capability the selectable catalog filters on", () => {
    for (const model of CLAUDE_CODE_DEFAULT_MODELS) {
      expect(model.capabilities?.functionCalling).toBe(true);
      expect(model.kind).toBe("text");
    }
  });
});

it.each([0, -1, 1.5, 101, Number.MAX_SAFE_INTEGER + 1])(
  "validates the Claude Code native limit at the provider (%s)",
  (nativeMaxTurns) => {
    expect(() =>
      claudeCodeProvider({ env }).languageModel("sonnet", { nativeMaxTurns })
    ).toThrow("between 1 and 100");
  }
);

it("refuses native limits for a provider that does not support them", () => {
  const manager = new Models({
    providers: [
      {
        ...claudeCodeProvider({
          config: { available: true },
          env,
          models: CLAUDE_CODE_DEFAULT_MODELS,
        }),
        turnLimit: "unsupported",
      },
    ],
  });
  expect(() =>
    manager.resolve("text", "claude-code/sonnet").open({ nativeMaxTurns: 3 })
  ).toThrow("a native turn limit");
});

it.each([1, 100])(
  "accepts the provider's native limit boundary (%s)",
  async (nativeMaxTurns) => {
    const model = claudeCodeProvider({ env }).languageModel("sonnet", {
      nativeMaxTurns,
    });
    await model.supportedUrls;
    expect(languageModel).toHaveBeenLastCalledWith("sonnet", {
      env: {},
      maxTurns: nativeMaxTurns,
      spawnClaudeCodeProcess: spawnRecordedCli,
    });
  }
);

describe("a Claude Code call that resumed no session", () => {
  const CALL = { prompt: [] } as unknown as LanguageModelV4CallOptions;
  const REPORTED = { "claude-code": { costUsd: 0.25, sessionId: "s" } };
  const FINISH = {
    finishReason: { raw: undefined, unified: "stop" },
    providerMetadata: REPORTED,
    type: "finish",
    usage: {
      inputTokens: {
        cacheRead: undefined,
        cacheWrite: undefined,
        noCache: 1,
        total: 1,
      },
      outputTokens: { reasoning: undefined, text: 1, total: 1 },
    },
  } as const;

  function opened(settings: ClaudeCodeSettings | undefined) {
    const vendor = Object.assign(
      new MockLanguageModelV4({
        doGenerate: async () => ({
          content: [],
          finishReason: { raw: undefined, unified: "stop" },
          providerMetadata: REPORTED,
          usage: FINISH.usage,
          warnings: [],
        }),
        doStream: async () => ({
          stream: simulateReadableStream<LanguageModelV4StreamPart>({
            chunks: [FINISH],
          }),
        }),
      }),
      settings === undefined ? {} : { settings }
    );
    languageModel.mockReturnValueOnce(vendor as never);
    return claudeCodeProvider({ env }).languageModel("sonnet");
  }

  async function streamed(model: LanguageModelV4) {
    const { stream } = await model.doStream(CALL);
    const parts: LanguageModelV4StreamPart[] = [];
    for await (const part of stream) {
      parts.push(part);
    }
    const finish = parts.find((part) => part.type === "finish");
    return finish?.type === "finish" ? finish.providerMetadata : undefined;
  }

  it("is marked on the first call of an instance whose settings resume nothing, and only that call", async () => {
    const model = opened({ cwd: "/repo" });
    const first = await model.doGenerate(CALL);
    expect(claudeCodeCallCost(first.providerMetadata)).toBe(0.25);
    const second = await model.doGenerate(CALL);
    expect(second.providerMetadata).toEqual(REPORTED);
    expect(claudeCodeCallCost(second.providerMetadata)).toBeUndefined();

    const metadata = await streamed(opened({ cwd: "/repo" }));
    expect(claudeCodeCallCost(metadata)).toBe(0.25);
    expect(metadata?.["claude-code"]).toEqual(REPORTED["claude-code"]);
  });

  it.each<[string, ClaudeCodeSettings | undefined]>([
    ["resume", { resume: "earlier" }],
    ["continue", { continue: true }],
    ["sessionId", { sessionId: "11111111-1111-4111-8111-111111111111" }],
    ["sdkOptions.resume", { sdkOptions: { resume: "earlier" } }],
    [
      "sdkOptions.continue",
      { continue: false, sdkOptions: { continue: true } },
    ],
    [
      "continue under sdkOptions",
      { continue: true, sdkOptions: { continue: false } },
    ],
    ["extraArgs", { extraArgs: { resume: "earlier" } }],
    ["sdkOptions.extraArgs", { sdkOptions: { extraArgs: { continue: null } } }],
    ["unreadable settings", undefined],
  ])("is never marked when %s may resume a session", async (_, settings) => {
    const model = opened(settings);
    expect(
      claudeCodeCallCost((await model.doGenerate(CALL)).providerMetadata)
    ).toBeUndefined();
    expect(
      claudeCodeCallCost(await streamed(opened(settings)))
    ).toBeUndefined();
  });
});

describe("claude code default settings", () => {
  it("exposes default settings merged into a Claude Code model's settings", () => {
    const model = claudeCodeSdk
      .createClaudeCode({
        defaultSettings: { resume: "earlier", sdkOptions: { continue: true } },
      })
      .languageModel("sonnet", { maxTurns: 3 });
    expect(model).toBeInstanceOf(claudeCodeSdk.ClaudeCodeLanguageModel);
    expect((model as ClaudeCodeLanguageModel).settings).toMatchObject({
      maxTurns: 3,
      resume: "earlier",
      sdkOptions: { continue: true },
    });
  });

  it("accepts any Claude Code settings as the provider's default settings", () => {
    expectTypeOf<ClaudeCodeSettings>().toExtend<
      NonNullable<ClaudeCodeProviderConfig["defaultSettings"]>
    >();
    const defaultSettings: ClaudeCodeSettings = {
      resume: "earlier",
      sdkOptions: { continue: true },
    };
    expect(
      claudeCodeProvider({ config: { defaultSettings }, env: {} }).id
    ).toBe("claude-code");
  });
});
