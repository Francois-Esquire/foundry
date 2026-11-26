import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { UsageError } from "~/cli/errors";
import { parseArgs } from "~/cli/index";

function foundryRoot(): string {
  return process.env.FOUNDRY_ROOT || join(homedir(), ".foundry");
}

describe("parseArgs", () => {
  it("opens the dashboard with no command, and takes no command word for it", () => {
    expect(parseArgs([])).toMatchObject({ command: "dashboard" });
    expect(parseArgs(["--source", "/tmp/config.ts"])).toMatchObject({
      command: "dashboard",
      config: "/tmp/config.ts",
    });
    expect(() => parseArgs(["dashboard"])).toThrow(
      'unknown command "dashboard"'
    );
    for (const flag of ["--help", "-h", "help"]) {
      expect(parseArgs([flag]).command).toBe("help");
    }
  });

  it("supports top-level --json on data commands and refuses it on streaming/interactive commands", () => {
    expect(parseArgs(["status", "--json"])).toMatchObject({
      command: "status",
      json: true,
    });
    expect(parseArgs(["--json", "status"])).toMatchObject({
      command: "status",
      json: true,
    });
    expect(parseArgs(["--json", "tasks", "list"])).toMatchObject({
      command: "tasks",
      json: true,
    });
    expect(parseArgs(["runs", "--all", "--json"])).toMatchObject({
      action: "list",
      all: true,
      command: "runs",
      json: true,
    });
    for (const argv of [
      ["--json"],
      ["mcp", "--json"],
      ["watch", "rn-1", "--json"],
      ["help", "--json"],
    ]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(
        "does not support --json"
      );
    }
  });

  it("defaults to the authoring folder and the home state dir", () => {
    expect(parseArgs([])).toEqual({
      artifacts: join(foundryRoot(), "artifacts"),
      command: "dashboard",
      config: "./.foundry/marbles",
      directory: process.cwd(),
      dry: false,
      json: false,
      state: join(foundryRoot(), "marbles"),
    });
  });

  it("reads each resource listing for this workspace, or every workspace's with --all, with or without list", () => {
    for (const command of ["runs", "sessions", "artifacts", "sandboxes"]) {
      for (const words of [[command], [command, "list"]]) {
        expect(parseArgs(words)).toMatchObject({
          action: "list",
          all: false,
          command,
        });
        expect(parseArgs([...words, "--all"])).toMatchObject({
          action: "list",
          all: true,
          command,
        });
      }
      expect(() => parseArgs([command, "extra"])).toThrow(UsageError);
      expect(() => parseArgs([command, "list", "extra"])).toThrow(
        `${command} list takes no arguments but --all`
      );
    }
  });

  it("relinks artifacts, for this workspace or every workspace's with --all, and nothing else", () => {
    expect(parseArgs(["artifacts", "relink"])).toMatchObject({
      action: "relink",
      all: false,
      command: "artifacts",
    });
    expect(parseArgs(["artifacts", "relink", "--all"])).toMatchObject({
      action: "relink",
      all: true,
    });
    for (const command of ["runs", "sessions", "sandboxes"]) {
      expect(() => parseArgs([command, "relink"])).toThrow(
        `${command} takes list [--all]`
      );
    }
  });

  it("shares and unshares under the resource's own noun, by id and directory", () => {
    expect(
      parseArgs(["artifacts", "share", "artifact#a", "../two"])
    ).toMatchObject({
      action: "share",
      command: "artifacts",
      id: "artifact#a",
      kind: "artifact",
      with: "../two",
    });
    expect(parseArgs(["runs", "unshare", "rn-1", "."])).toMatchObject({
      action: "unshare",
      command: "runs",
      kind: "run",
    });
    expect(parseArgs(["sessions", "share", "ses-1", "."])).toMatchObject({
      action: "share",
      kind: "session",
    });
    expect(() => parseArgs(["runs", "share", "rn-1"])).toThrow(
      "runs share takes an id and another workspace's directory"
    );
    expect(() => parseArgs(["runs", "share", "rn-1", ".", "--all"])).toThrow(
      "runs share takes an id and another workspace's directory"
    );
    for (const action of ["share", "unshare"]) {
      expect(() => parseArgs(["sandboxes", action, "sb-1", "."])).toThrow(
        "sandboxes takes list [--all]; sandboxes are not shared with other workspaces"
      );
    }
  });

  it("reads start and stop, with optional --workspace on stop", () => {
    expect(parseArgs(["start"])).toMatchObject({ command: "start" });
    expect(() => parseArgs(["start", "extra"])).toThrow(
      "start takes no arguments"
    );
    expect(parseArgs(["stop"])).toMatchObject({
      command: "stop",
      workspace: false,
    });
    expect(parseArgs(["stop", "--workspace"])).toMatchObject({
      command: "stop",
      workspace: true,
    });
    expect(() => parseArgs(["stop", "extra"])).toThrow(
      "stop takes no arguments but --workspace"
    );
    expect(() => parseArgs(["stop", "--workspace", "extra"])).toThrow(
      "stop takes no arguments but --workspace"
    );
    expect(() => parseArgs(["stop", "--all"])).toThrow(
      "stop: unknown option --all"
    );
  });

  it("reads theme as print, list, or save by name", () => {
    expect(parseArgs(["theme"])).toMatchObject({
      action: "get",
      command: "theme",
    });
    expect(parseArgs(["theme", "list"])).toMatchObject({ action: "list" });
    expect(parseArgs(["theme", "light"])).toMatchObject({
      action: "set",
      theme: "light",
    });
    expect(() => parseArgs(["theme", "no-such-theme"])).toThrow(
      'unknown theme "no-such-theme"; marbles theme list shows them'
    );
    expect(() => parseArgs(["theme", "light", "dark"])).toThrow(
      "theme takes list, or one theme name to save it"
    );
  });

  it("reads enqueue by name, with --key and --input on either side of it", () => {
    expect(parseArgs(["enqueue", "build"])).toMatchObject({
      command: "enqueue",
      name: "build",
    });
    expect(parseArgs(["enqueue", "build"])).not.toHaveProperty("key");
    for (const argv of [
      ["enqueue", "build", "--key", "pr-1"],
      ["enqueue", "--key", "pr-1", "build"],
    ]) {
      expect(parseArgs(argv)).toMatchObject({
        command: "enqueue",
        key: "pr-1",
        name: "build",
      });
    }
    expect(parseArgs(["enqueue", "build", "--input", '{"a":1}'])).toMatchObject(
      { command: "enqueue", inputJson: '{"a":1}', name: "build" }
    );
    expect(() => parseArgs(["enqueue", "build", "--key", " "])).toThrow(
      "enqueue: --key takes a key that is not blank"
    );
    for (const flag of ["--json", "-h", "--help", "--input"]) {
      expect(() => parseArgs(["enqueue", "build", "--key", flag])).toThrow(
        `enqueue: --key takes a value, not the flag ${flag}`
      );
    }
    expect(() => parseArgs(["enqueue", "build", "--key"])).toThrow(
      "enqueue: --key takes a value"
    );
    expect(() =>
      parseArgs(["enqueue", "build", "--key", "a", "--key", "b"])
    ).toThrow("enqueue takes one step or workflow name");
    expect(() => parseArgs(["enqueue"])).toThrow(
      "enqueue takes one step or workflow name"
    );
    expect(() => parseArgs(["run", "build", "--key", "a"])).toThrow(
      "run: unknown option --key"
    );
  });

  it("reads positionals around flags and scopes --input to run, enqueue, and tasks change", () => {
    const args = parseArgs(["run", "--json", "guides", "--source", "/c.ts"]);
    expect(args).toMatchObject({
      command: "run",
      config: "/c.ts",
      json: true,
      name: "guides",
    });
    expect(parseArgs(["run", "ask", "--input", '{"q":1}'])).toMatchObject({
      command: "run",
      inputJson: '{"q":1}',
      name: "ask",
    });
    expect(parseArgs(["run", "ask", "--input", "-1"])).toMatchObject({
      command: "run",
      inputJson: "-1",
      name: "ask",
    });
    for (const argv of [
      ["status", "--input", "{}"],
      ["list", "--input", "{}"],
      ["theme", "--input", "{}"],
    ]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(
        "unknown option --input"
      );
    }
  });

  it("refuses unknown and removed flags by name, even beside --help", () => {
    for (const flag of [
      "--dry",
      "--dry-run",
      "--recheck-providers",
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
      ["--source"],
      ["list", "--source"],
      ["run", "ask", "--input"],
      ["tasks", "change", "--input"],
    ]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(
        `${argv.at(-1)} takes a value`
      );
    }
  });

  it("refuses a flag where --source or --input takes its value", () => {
    for (const command of [[], ["run", "ask"], ["start"]]) {
      expect(() => parseArgs([...command, "--source", "--json"])).toThrow(
        "--source takes a value, not the flag --json"
      );
    }
    expect(() => parseArgs(["--source", "--help"])).toThrow(
      "--source takes a value, not the flag --help"
    );
    expect(() => parseArgs(["run", "ask", "--input", "-h"])).toThrow(
      "run: --input takes a value, not the flag -h"
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
    [
      ["run"],
      'run takes a step, workflow, schedule, or monitor name; run "marbles" with no command to open the dashboard',
    ],
    [
      ["run", "a", "b"],
      "run takes one step, workflow, schedule, or monitor name",
    ],
    [
      ["roll", "ping"],
      'unknown command "roll"; roll is now marbles run <name>',
    ],
    [
      ["daemon"],
      'unknown command "daemon"; daemon is now marbles start or marbles stop',
    ],
    [
      ["daemon", "stop"],
      'unknown command "daemon"; daemon is now marbles start or marbles stop',
    ],
    [["attach"], 'unknown command "attach"; attach is now marbles start'],
    [
      ["detach"],
      'unknown command "detach"; detach is now marbles stop --workspace',
    ],
    [
      ["relink"],
      'unknown command "relink"; relink is now marbles artifacts relink',
    ],
    [
      ["relink", "--all"],
      'unknown command "relink"; relink is now marbles artifacts relink',
    ],
    [
      ["settings", "themes"],
      'unknown command "settings"; settings is now marbles theme',
    ],
    [["share", "run", "rn-1", "."], 'unknown command "share"'],
    [["unshare", "run", "rn-1", "."], 'unknown command "unshare"'],
    [
      ["init", "unknown"],
      "init takes one starter: developer, design, or product",
    ],
    [["launchd", "install", "ping"], 'unknown command "launchd"'],
    [["launchd", "uninstall", "ping"], 'unknown command "launchd"'],
    [["list", "extra"], "list takes no arguments"],
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
  expect(parseArgs(["mcp", "--source", "/tmp/source.ts"])).toMatchObject({
    command: "mcp",
    config: "/tmp/source.ts",
  });
  expect(() => parseArgs(["mcp", "list"])).toThrow("mcp takes no arguments");
  expect(() => parseArgs(["mcp", "--harness", "codex"])).toThrow(
    "mcp: unknown option --harness"
  );
  expect(parseArgs(["mcp", "--help"]).command).toBe("help");
});
