import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseArgs } from "~/args";

describe("parseArgs", () => {
  it("defaults to the repo config and the home state dir", () => {
    expect(parseArgs([])).toEqual({
      command: undefined,
      config: "./quirks.config.ts",
      dry: false,
      inputJson: undefined,
      name: undefined,
      only: [],
      state: join(homedir(), ".foundry", "quirks"),
      target: undefined,
    });
  });

  it("reads three positionals around flags", () => {
    const args = parseArgs([
      "launchd",
      "--dry",
      "install",
      "--state",
      "/s",
      "guides",
      "--config",
      "/c.ts",
    ]);
    expect(args.command).toBe("launchd");
    expect(args.name).toBe("install");
    expect(args.target).toBe("guides");
    expect(args.dry).toBe(true);
    expect(args.state).toBe("/s");
    expect(args.config).toBe("/c.ts");
  });

  it("keeps --input raw and collects every --harness", () => {
    const args = parseArgs([
      "once",
      "ask",
      "--input",
      '{"q":1}',
      "--harness",
      "codex",
      "--harness",
      "claude-code",
    ]);
    expect(args.inputJson).toBe('{"q":1}');
    expect(args.only).toEqual(["codex", "claude-code"]);
  });

  it("keeps the default when a flag has no value", () => {
    const args = parseArgs(["list", "--config"]);
    expect(args.config).toBe("./quirks.config.ts");
    expect(parseArgs(["list", "--harness"]).only).toEqual([]);
  });
});
