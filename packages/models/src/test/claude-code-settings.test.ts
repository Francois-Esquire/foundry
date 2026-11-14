import {
  ClaudeCodeLanguageModel,
  createClaudeCode,
} from "ai-sdk-provider-claude-code";
import { expect, it } from "vitest";

// The fresh-call mark reads the instance's public `settings`. This pins
// that they hold the provider's default settings merged with the model's.
it("exposes default settings merged into a Claude Code model's settings", () => {
  const model = createClaudeCode({
    defaultSettings: { resume: "earlier", sdkOptions: { continue: true } },
  }).languageModel("sonnet", { maxTurns: 3 });
  expect(model).toBeInstanceOf(ClaudeCodeLanguageModel);
  expect((model as ClaudeCodeLanguageModel).settings).toMatchObject({
    maxTurns: 3,
    resume: "earlier",
    sdkOptions: { continue: true },
  });
});
