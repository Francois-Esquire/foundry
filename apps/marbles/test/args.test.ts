import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseArgs } from "~/args";

describe("parseArgs", () => {
  it("treats no command and explicit run identically, while help stays explicit", () => {
    expect(parseArgs([])).toEqual(parseArgs(["run"]));
    expect(parseArgs(["--dry-run", "--config", "/tmp/config.ts"])).toEqual(
      parseArgs(["run", "--dry-run", "--config", "/tmp/config.ts"])
    );
    for (const flag of ["--help", "-h", "help"]) {
      expect(parseArgs([flag]).command).toBe("help");
    }
  });
  it("defaults to the authoring folder and the home state dir", () => {
    expect(parseArgs([])).toEqual({
      artifacts: join(homedir(), ".foundry", "artifacts"),
      command: "run",
      config: "./.foundry/marbles",
      dry: false,
      inputJson: undefined,
      name: undefined,
      only: [],
      state: join(homedir(), ".foundry", "marbles"),
      target: undefined,
    });
  });

  it("reads three positionals around flags", () => {
    const args = parseArgs([
      "launchd",
      "--dry-run",
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

  it("still reads the older --dry spelling as a flag, never as a positional", () => {
    const args = parseArgs(["roll", "ask", "--dry"]);
    expect(args.dry).toBe(true);
    expect(args.target).toBeUndefined();
  });

  it("keeps --input raw and collects every --harness", () => {
    const args = parseArgs([
      "roll",
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
    expect(args.config).toBe("./.foundry/marbles");
    expect(parseArgs(["list", "--harness"]).only).toEqual([]);
  });
});

it("accepts --source with the same last-value precedence as --config", () => {
  expect(parseArgs(["--config", "old.ts", "--source", "new"]).config).toBe(
    "new"
  );
});
