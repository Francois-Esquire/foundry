import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeProvider } from "../claude-code";
import { codexProvider } from "../codex";
import { environmentOverlay } from "../environment";
import { envDumpExecutable } from "./helpers/env-dump";

const CALL = {
  prompt: [{ content: [{ text: "hi", type: "text" }], role: "user" }],
} as LanguageModelV4CallOptions;

const saved = { ...process.env };
let cli: ReturnType<typeof envDumpExecutable>;

/** What a machine-scope instance is given: the environment without the workspace's additions. */
function machineEnvironment(): Record<string, string> {
  return {
    CLAUDE_TEST_ACCOUNT: "machine",
    HOME: process.env.HOME ?? "",
    PATH: process.env.PATH ?? "",
  };
}

beforeEach(() => {
  cli = envDumpExecutable();
  process.env.ANTHROPIC_API_KEY = "workspace-key";
  process.env.OPENAI_API_KEY = "workspace-key";
  process.env.CLAUDE_TEST_ACCOUNT = "workspace";
});

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in saved)) {
      delete process.env[name];
    }
  }
  Object.assign(process.env, saved);
  cli.remove();
});

describe("environmentOverlay", () => {
  it("spells out every difference from the ambient environment", () => {
    expect(
      environmentOverlay({ ADDED: "a", CHANGED: "new", SAME: "s" }, undefined, {
        CHANGED: "old",
        REMOVED: "r",
        SAME: "s",
      })
    ).toEqual({ ADDED: "a", CHANGED: "new", REMOVED: undefined });
  });

  it("uses the given value for removed names", () => {
    expect(environmentOverlay({}, "", { REMOVED: "r" })).toEqual({
      REMOVED: "",
    });
  });
});

describe("a CLI child process sees only the environment it was given", () => {
  it("removes names from a Claude Code child", async () => {
    const provider = claudeCodeProvider({
      config: { defaultSettings: { pathToClaudeCodeExecutable: cli.bin } },
      env: machineEnvironment(),
    });
    await expect(
      provider.languageModel("sonnet").doGenerate(CALL)
    ).rejects.toThrow();
    const seen = cli.read();
    expect(seen).toBeDefined();
    expect(seen).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(seen?.CLAUDE_TEST_ACCOUNT).toBe("machine");
  });

  it("empties names in a Codex child, whose SDK accepts only strings", async () => {
    const provider = codexProvider({
      config: { available: true, binPath: cli.bin },
      env: machineEnvironment(),
    });
    try {
      await expect(
        provider.languageModel("gpt-5.5").doGenerate(CALL)
      ).rejects.toThrow();
    } finally {
      await provider.dispose?.();
    }
    const seen = cli.read();
    expect(seen).toBeDefined();
    expect(seen?.OPENAI_API_KEY).toBe("");
    expect(seen?.ANTHROPIC_API_KEY).toBe("");
    expect(seen?.CLAUDE_TEST_ACCOUNT).toBe("machine");
  });

  it("masks a name added to process.env after the Claude Code model was opened", async () => {
    const model = claudeCodeProvider({
      config: { defaultSettings: { pathToClaudeCodeExecutable: cli.bin } },
      env: machineEnvironment(),
    }).languageModel("sonnet");
    process.env.ANTHROPIC_LATE_TOKEN = "workspace-late";
    await expect(model.doGenerate(CALL)).rejects.toThrow();
    expect(cli.read()).not.toHaveProperty("ANTHROPIC_LATE_TOKEN");
  });

  it("refuses Claude Code config that would set or bypass the environment", () => {
    for (const defaultSettings of [
      { env: { ANTHROPIC_API_KEY: "x" } },
      { sdkOptions: { env: { ANTHROPIC_API_KEY: "x" } } },
      { sdkOptions: { spawnClaudeCodeProcess: () => undefined as never } },
      { spawnClaudeCodeProcess: () => undefined as never },
    ]) {
      expect(() =>
        claudeCodeProvider({ config: { defaultSettings }, env: {} })
      ).toThrow("only from the provider's env option");
    }
  });

  it("passes a workspace value to a child given it", async () => {
    const provider = claudeCodeProvider({
      config: { defaultSettings: { pathToClaudeCodeExecutable: cli.bin } },
      env: { ...machineEnvironment(), ANTHROPIC_API_KEY: "workspace-key" },
    });
    await expect(
      provider.languageModel("sonnet").doGenerate(CALL)
    ).rejects.toThrow();
    expect(cli.read()?.ANTHROPIC_API_KEY).toBe("workspace-key");
  });
});
