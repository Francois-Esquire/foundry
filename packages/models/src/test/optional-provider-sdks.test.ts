import { expect, it, vi } from "vitest";

vi.mock("ai-sdk-provider-claude-code", () => {
  throw new Error("Claude Code SDK unavailable");
});
vi.mock("ai-sdk-provider-codex-cli", () => {
  throw new Error("Codex SDK unavailable");
});
vi.mock("ai-sdk-provider-pi", () => {
  throw new Error("Pi SDK unavailable");
});

it("constructs and disposes unused providers without their SDKs", async () => {
  const [{ claudeCodeProvider }, { codexProvider }, { piProvider }] =
    await Promise.all([
      import("../claude-code"),
      import("../codex"),
      import("../pi"),
    ]);
  for (const provider of [
    claudeCodeProvider({ env: {} }),
    codexProvider({ env: {} }),
    piProvider(),
  ]) {
    expect(provider.languageModel("example").modelId).toBe("example");
    await provider.dispose?.();
  }
});
