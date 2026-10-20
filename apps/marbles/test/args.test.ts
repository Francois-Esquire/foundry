import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseArgs, UsageError } from "~/args";

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
      only: [],
      state: join(homedir(), ".foundry", "marbles"),
    });
  });

  it("reads positionals around flags", () => {
    const args = parseArgs([
      "roll",
      "--dry-run",
      "--state",
      "/s",
      "guides",
      "--config",
      "/c.ts",
    ]);
    expect(args).toMatchObject({
      command: "roll",
      name: "guides",
    });
    expect(args.dry).toBe(true);
    expect(args.state).toBe("/s");
    expect(args.config).toBe("/c.ts");
  });

  it("still reads the older --dry spelling as a flag, never as a positional", () => {
    const args = parseArgs(["roll", "ask", "--dry"]);
    expect(args).toMatchObject({ command: "roll", dry: true, name: "ask" });
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

it("refuses a command line that cannot run, before anything else happens", () => {
  const refusals: [readonly string[], string][] = [
    [["bogus"], 'unknown command "bogus"'],
    [["roll"], "roll takes one workflow or schedule name"],
    [["roll", "a", "b"], "roll takes one workflow or schedule name"],
    [["run", "ping"], "run takes no name. To run one now: marbles roll ping"],
    [
      ["init", "unknown"],
      "init takes one starter: developer, design, or product",
    ],
    [["launchd", "install", "ping"], 'unknown command "launchd"'],
    [["launchd", "uninstall", "ping"], 'unknown command "launchd"'],
    [["list", "extra"], "list takes no arguments"],
    [
      ["--harness", "foo"],
      'unknown harness "foo"; --harness takes claude-code or codex or pi',
    ],
  ];
  for (const [argv, message] of refusals) {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(message);
  }
  // Help wins over whatever else is on the line.
  expect(parseArgs(["bogus", "--help"]).command).toBe("help");
  expect(parseArgs(["--help", "--harness", "foo"]).command).toBe("help");
  // A default is decided where the line is read, not by the command.
  expect(parseArgs(["init"])).toMatchObject({ starter: "product" });
});

it("parses watch by run ID and refuses missing or extra arguments", () => {
  expect(
    parseArgs(["watch", "rn-test", "--state", "/tmp/state"])
  ).toMatchObject({ command: "watch", runId: "rn-test", state: "/tmp/state" });
  expect(() => parseArgs(["watch"])).toThrow("watch takes one run ID");
  expect(() => parseArgs(["watch", "one", "two"])).toThrow(
    "watch takes one run ID"
  );
});
