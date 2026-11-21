import {
  ClaudeCodeLanguageModel,
  type ClaudeCodeSettings,
  createClaudeCode,
} from "ai-sdk-provider-claude-code";
import { expect, expectTypeOf, it } from "vitest";
import {
  type ClaudeCodeProviderConfig,
  claudeCodeProvider,
} from "../claude-code";

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

it("accepts any Claude Code settings as the provider's default settings", () => {
  expectTypeOf<ClaudeCodeSettings>().toExtend<
    NonNullable<ClaudeCodeProviderConfig["defaultSettings"]>
  >();
  const defaultSettings: ClaudeCodeSettings = {
    resume: "earlier",
    sdkOptions: { continue: true },
  };
  expect(claudeCodeProvider({ config: { defaultSettings }, env: {} }).id).toBe(
    "claude-code"
  );
});
