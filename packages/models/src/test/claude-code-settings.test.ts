import {
  ClaudeCodeLanguageModel,
  createClaudeCode,
} from "ai-sdk-provider-claude-code";
import { expect, it } from "vitest";

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
