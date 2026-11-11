import { describe, expect, it, vi } from "vitest";
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
