import { expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  throw new Error("Claude Agent SDK unavailable");
});

it("loads shared usage and reads API key limits without the Claude Agent SDK", async () => {
  const { usage } = await import("../index");
  const { anthropic } = await import("../providers/anthropic");

  expect(usage).toBeDefined();
  await expect(anthropic({ apiKey: "test" }).limits()).resolves.toEqual({
    limits: [],
    unsupported: "An Anthropic API key has no limits to read.",
  });
});
