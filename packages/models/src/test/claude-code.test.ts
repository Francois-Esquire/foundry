import { describe, expect, it, vi } from "vitest";
import { ModelManager } from "../manager";

const VERSION_DIGIT_PATTERN = /\d/;

const languageModel = vi.fn((modelId: string) => ({ modelId }));
const createClaudeCode = vi.fn(() => ({ languageModel }));

vi.mock("ai-sdk-provider-claude-code", () => ({ createClaudeCode }));

const { CLAUDE_CODE_DEFAULT_MODELS, claudeCodeProvider } = await import(
  "../claude-code"
);

describe("claudeCodeProvider", () => {
  it("is unavailable until the host says otherwise", () => {
    expect(claudeCodeProvider().available).toBe(false);
  });

  it("becomes available when configured, and can be switched back off", () => {
    const provider = claudeCodeProvider();
    provider.configure?.({ available: true });
    expect(provider.available).toBe(true);
    provider.configure?.({ available: false });
    expect(provider.available).toBe(false);
  });

  it("names itself as the harness that runs the turn", () => {
    expect(claudeCodeProvider().harness).toBe("claude-code");
  });

  it("mounts a turn-scoped working directory when it builds the model", () => {
    claudeCodeProvider().languageModel("sonnet", { workingDirectory: "/repo" });
    expect(languageModel).toHaveBeenLastCalledWith("sonnet", { cwd: "/repo" });
  });

  it("passes a native turn limit to Claude Code", () => {
    claudeCodeProvider().languageModel("sonnet", {
      nativeMaxTurns: 7,
      workingDirectory: "/repo",
    });
    expect(languageModel).toHaveBeenLastCalledWith("sonnet", {
      cwd: "/repo",
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
      claudeCodeProvider().languageModel("sonnet", { nativeMaxTurns })
    ).toThrow("between 1 and 100");
  }
);

it("refuses native limits for a provider that does not support them", () => {
  const manager = new ModelManager({
    providers: [
      {
        ...claudeCodeProvider({ config: { available: true } }),
        nativeTurnLimit: false,
      },
    ],
  });
  expect(() =>
    manager.model("sonnet", "claude-code", { nativeMaxTurns: 3 })
  ).toThrow("maxTurns is not supported");
});

it.each([1, 100])(
  "accepts the provider's native limit boundary (%s)",
  (nativeMaxTurns) => {
    claudeCodeProvider().languageModel("sonnet", { nativeMaxTurns });
    expect(languageModel).toHaveBeenLastCalledWith("sonnet", {
      maxTurns: nativeMaxTurns,
    });
  }
);
