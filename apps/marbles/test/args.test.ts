import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseArgs, UsageError } from "~/cli/args";

function foundryHome(): string {
  return process.env.FOUNDRY_HOME ?? join(homedir(), ".foundry");
}

describe("parseArgs", () => {
  it("treats no command and explicit run identically, while help stays explicit", () => {
    expect(parseArgs([])).toEqual(parseArgs(["run"]));
    expect(parseArgs(["--dry-run", "--source", "/tmp/config.ts"])).toEqual(
      parseArgs(["run", "--dry-run", "--source", "/tmp/config.ts"])
    );
    for (const flag of ["--help", "-h", "help"]) {
      expect(parseArgs([flag]).command).toBe("help");
    }
  });
  it("defaults to the authoring folder and the home state dir", () => {
    expect(parseArgs([])).toEqual({
      artifacts: join(foundryHome(), "artifacts"),
      command: "run",
      config: "./.foundry/marbles",
      directory: process.cwd(),
      dry: false,
      inputJson: undefined,
      state: join(foundryHome(), "marbles"),
    });
  });

  it("reads each resource listing for this workspace, or every workspace's with --all", () => {
    for (const command of [
      "runs",
      "sessions",
      "artifacts",
      "sandboxes",
      "relink",
    ]) {
      expect(parseArgs([command])).toMatchObject({ all: false, command });
      expect(parseArgs([command, "--all"])).toMatchObject({
        all: true,
        command,
      });
      expect(() => parseArgs([command, "extra"])).toThrow(UsageError);
    }
  });

  it("reads share and unshare as a kind, an id and a directory, and refuses a kind it does not know", () => {
    expect(
      parseArgs(["share", "artifact", "artifact#a", "../two"])
    ).toMatchObject({
      command: "share",
      id: "artifact#a",
      kind: "artifact",
      with: "../two",
    });
    expect(parseArgs(["unshare", "run", "rn-1", "."])).toMatchObject({
      command: "unshare",
      kind: "run",
    });
    expect(() => parseArgs(["share", "task", "t1", "."])).toThrow(UsageError);
    expect(() => parseArgs(["share", "run", "rn-1"])).toThrow(UsageError);
  });

  it("reads positionals around flags", () => {
    const args = parseArgs([
      "roll",
      "--dry-run",
      "guides",
      "--source",
      "/c.ts",
    ]);
    expect(args).toMatchObject({
      command: "roll",
      name: "guides",
    });
    expect(args.dry).toBe(true);
    expect(args.config).toBe("/c.ts");
  });

  it("keeps --input raw, including a negative number", () => {
    expect(parseArgs(["roll", "ask", "--input", '{"q":1}']).inputJson).toBe(
      '{"q":1}'
    );
    expect(parseArgs(["roll", "ask", "--input", "-1"]).inputJson).toBe("-1");
  });

  it("refuses an unknown flag by name, the removed ones included, even beside --help", () => {
    for (const flag of [
      "--dry",
      "--config",
      "--harness",
      "--state",
      "--artifacts",
      "--bogus",
    ]) {
      expect(() => parseArgs([flag, "x"])).toThrow(`unknown option ${flag}`);
      expect(() => parseArgs(["watch", "rn-test", flag, "x"])).toThrow(
        `watch: unknown option ${flag}`
      );
      expect(() => parseArgs(["--help", flag, "x"])).toThrow(UsageError);
      expect(() => parseArgs(["runs", flag])).toThrow(
        `runs: unknown option ${flag}`
      );
    }
    expect(() => parseArgs(["list", "--all"])).toThrow(
      "list: unknown option --all"
    );
  });

  it("refuses a value flag with no value", () => {
    for (const argv of [
      ["run", "--source"],
      ["list", "--source"],
      ["roll", "ask", "--input"],
      ["tasks", "change", "--input"],
    ]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(
        `${argv.at(-1)} takes a value`
      );
    }
  });

  it("refuses a flag where --source or --input takes its value, so a dry run never runs live", () => {
    for (const command of ["run", "attach"]) {
      expect(() => parseArgs([command, "--source", "--dry-run"])).toThrow(
        "--source takes a value, not the flag --dry-run"
      );
    }
    expect(() => parseArgs(["--source", "--help"])).toThrow(
      "--source takes a value, not the flag --help"
    );
    expect(() => parseArgs(["roll", "ask", "--input", "-h"])).toThrow(
      "--input takes a value, not the flag -h"
    );
  });
});

it("takes the last of repeated --source values", () => {
  expect(parseArgs(["--source", "old.ts", "--source", "new"]).config).toBe(
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
    [["attach", "extra"], "attach takes no arguments"],
    [["detach", "extra"], "detach takes no arguments"],
    [["--harness", "foo"], "unknown option --harness"],
  ];
  for (const [argv, message] of refusals) {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(message);
  }
  expect(parseArgs(["bogus", "--help"]).command).toBe("help");
  expect(parseArgs(["init"])).toMatchObject({ starter: "product" });
});

it("parses watch by run ID and refuses missing or extra arguments", () => {
  expect(parseArgs(["watch", "rn-test"])).toMatchObject({
    command: "watch",
    runId: "rn-test",
  });
  expect(() => parseArgs(["watch"])).toThrow("watch takes one run ID");
  expect(() => parseArgs(["watch", "one", "two"])).toThrow(
    "watch takes one run ID"
  );
});

it("parses the mcp command, which takes flags only", () => {
  expect(
    parseArgs(["mcp", "--source", "/tmp/source.ts", "--dry-run"])
  ).toMatchObject({ command: "mcp", config: "/tmp/source.ts", dry: true });
  expect(() => parseArgs(["mcp", "list"])).toThrow("mcp takes no arguments");
  expect(() => parseArgs(["mcp", "--harness", "codex"])).toThrow(
    "mcp: unknown option --harness"
  );
  expect(parseArgs(["mcp", "--help"]).command).toBe("help");
});
