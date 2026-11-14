import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import { describe, expect, it, vi } from "vitest";
import { claudeCodeCallCost } from "../cost";
import { ModelManager } from "../manager";

const VERSION_DIGIT_PATTERN = /\d/;

const languageModel = vi.fn((modelId: string) => ({ modelId }));
const createClaudeCode = vi.fn(() => ({ languageModel }));

vi.mock("ai-sdk-provider-claude-code", () => ({ createClaudeCode }));

const { CLAUDE_CODE_DEFAULT_MODELS, claudeCodeProvider } = await import(
  "../claude-code"
);

/** The ambient environment itself, so the overlay each model gets is empty. */
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined
  )
);

describe("claudeCodeProvider", () => {
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

  it("mounts a turn-scoped working directory when it builds the model", () => {
    claudeCodeProvider({ env }).languageModel("sonnet", {
      workingDirectory: "/repo",
    });
    expect(languageModel).toHaveBeenLastCalledWith("sonnet", {
      cwd: "/repo",
      env: {},
    });
  });

  it("passes a native turn limit to Claude Code", () => {
    claudeCodeProvider({ env }).languageModel("sonnet", {
      nativeMaxTurns: 7,
      workingDirectory: "/repo",
    });
    expect(languageModel).toHaveBeenLastCalledWith("sonnet", {
      cwd: "/repo",
      env: {},
      maxTurns: 7,
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
  const manager = new ModelManager({
    providers: [
      {
        ...claudeCodeProvider({ config: { available: true }, env }),
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
  (nativeMaxTurns) => {
    claudeCodeProvider({ env }).languageModel("sonnet", { nativeMaxTurns });
    expect(languageModel).toHaveBeenLastCalledWith("sonnet", {
      env: {},
      maxTurns: nativeMaxTurns,
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

  /** A vendor model with these settings, as the provider would build it. */
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
    // The instance now resumes the session the first call opened.
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
