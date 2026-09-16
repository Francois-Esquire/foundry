import { describe, expect, it, vi } from "vitest";

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

  it("offers only family aliases, never a pinned version", () => {
    for (const model of CLAUDE_CODE_DEFAULT_MODELS) {
      expect(model.id).toBe(model.modelId);
      expect(model.id).not.toMatch(/\d/);
    }
  });

  it("declares every capability the selectable catalog filters on", () => {
    for (const model of CLAUDE_CODE_DEFAULT_MODELS) {
      expect(model.capabilities?.functionCalling).toBe(true);
      expect(model.kind).toBe("text");
    }
  });
});
