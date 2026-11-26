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
      sourceExplicit: true,
    });
    expect(() => parseArgs(["dashboard"])).toThrow(
      'unknown command "dashboard"'
    );
    for (const flag of ["--help", "-h", "help"]) {
      expect(parseArgs([flag]).command).toBe("help");
    }
  });

  it("supports top-level --json on data commands and refuses it on streaming/interactive commands", () => {
    expect(parseArgs(["workspaces", "--json"])).toMatchObject({
      action: "list",
      command: "workspaces",
      json: true,
    });
    expect(parseArgs(["--json", "workspaces", "get", "ws-1"])).toMatchObject({
      action: "get",
      command: "workspaces",
      id: "ws-1",
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

  it("reads each resource list/get with --workspace or --all, and rejects removed share/unshare/relink", () => {
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
        expect(parseArgs([...words, "--workspace", "ws-1"])).toMatchObject({
          action: "list",
          all: false,
          command,
          workspace: "ws-1",
        });
      }
      expect(parseArgs([command, "get", "id-1"])).toMatchObject({
        action: "get",
        all: false,
        command,
        id: "id-1",
      });
      expect(
        parseArgs([command, "get", "id-1", "--workspace", "ws-1"])
      ).toMatchObject({
        action: "get",
        all: false,
        command,
        id: "id-1",
        workspace: "ws-1",
      });
      expect(() =>
        parseArgs([command, "list", "--all", "--workspace", "ws-1"])
      ).toThrow(`${command} takes --workspace or --all, not both`);
      expect(() => parseArgs([command, "get"])).toThrow(
        `${command} get takes one id`
      );
      expect(() => parseArgs([command, "extra"])).toThrow(
        `${command} takes list or get <id>`
      );
      expect(() => parseArgs([command, "share", "id-1", "."])).toThrow(
        `${command} takes list or get <id>`
      );
      expect(() => parseArgs([command, "relink"])).toThrow(
        `${command} takes list or get <id>`
      );
      expect(() => parseArgs([command, "list", "extra"])).toThrow(
        `${command} list takes no arguments besides --workspace or --all`
      );
    }
  });

  it("reads workspaces list and get", () => {
    expect(parseArgs(["workspaces"])).toMatchObject({
      action: "list",
      command: "workspaces",
    });
    expect(parseArgs(["workspaces", "list"])).toMatchObject({
      action: "list",
      command: "workspaces",
    });
    expect(parseArgs(["workspaces", "get", "ws-1"])).toMatchObject({
      action: "get",
      command: "workspaces",
      id: "ws-1",
    });
    expect(() => parseArgs(["workspaces", "get"])).toThrow(
      "workspaces get takes one workspace id or directory"
    );
    expect(() => parseArgs(["workspaces", "bogus"])).toThrow(
      "workspaces takes list or get <id|dir>"
    );
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

  it("reads settings as show, get, set, or themes", () => {
    expect(parseArgs(["settings"])).toMatchObject({
      action: "show",
      command: "settings",
    });
    expect(parseArgs(["settings", "themes"])).toMatchObject({
      action: "themes",
      command: "settings",
    });
    expect(parseArgs(["settings", "get", "theme"])).toMatchObject({
      action: "get",
      command: "settings",
      key: "theme",
    });
    expect(parseArgs(["settings", "set", "theme", "light"])).toMatchObject({
      action: "set",
      command: "settings",
      key: "theme",
      value: "light",
    });
    expect(() => parseArgs(["settings", "set", "theme", "no-such"])).toThrow(
      'unknown theme "no-such"; marbles settings themes lists them'
    );
    expect(() => parseArgs(["settings", "get", "bogus"])).toThrow(
      'unknown setting "bogus"; valid keys: theme'
    );
    expect(() => parseArgs(["settings", "unknown"])).toThrow(
      "settings takes get <key>, set <key> <value>, or themes"
    );
  });

  it("reads trigger for blocking and --async execution, with --input and --key", () => {
    expect(parseArgs(["trigger", "build"])).toMatchObject({
      async: false,
      command: "trigger",
      name: "build",
    });
    expect(parseArgs(["trigger", "build"])).not.toHaveProperty("key");
    for (const argv of [
      ["trigger", "build", "--async", "--key", "pr-1"],
      ["trigger", "--key", "pr-1", "--async", "build"],
    ]) {
      expect(parseArgs(argv)).toMatchObject({
        async: true,
        command: "trigger",
        key: "pr-1",
        name: "build",
      });
    }
    expect(
      parseArgs(["trigger", "build", "--async", "--input", '{"a":1}'])
    ).toMatchObject({
      async: true,
      command: "trigger",
      inputJson: '{"a":1}',
      name: "build",
    });
    expect(parseArgs(["trigger", "ask", "--input", "-1"])).toMatchObject({
      async: false,
      command: "trigger",
      inputJson: "-1",
      name: "ask",
    });
    expect(() => parseArgs(["trigger", "build", "--key", "pr-1"])).toThrow(
      "trigger: --key requires --async"
    );
    expect(() =>
      parseArgs(["trigger", "build", "--async", "--key", " "])
    ).toThrow("trigger: --key takes a key that is not blank");
    for (const flag of ["--json", "-h", "--help", "--input"]) {
      expect(() =>
        parseArgs(["trigger", "build", "--async", "--key", flag])
      ).toThrow(`trigger: --key takes a value, not the flag ${flag}`);
    }
    expect(() => parseArgs(["trigger", "build", "--async", "--key"])).toThrow(
      "trigger: --key takes a value"
    );
    expect(() =>
      parseArgs(["trigger", "build", "--async", "--key", "a", "--key", "b"])
    ).toThrow("trigger: --key may only be given once");
    expect(() => parseArgs(["trigger"])).toThrow(
      'trigger takes one step, workflow, schedule, or monitor name; run "marbles" with no command to open the dashboard'
    );
    expect(() => parseArgs(["trigger", "a", "b"])).toThrow(
      "trigger takes one step, workflow, schedule, or monitor name"
    );
  });

  it("scopes --input to trigger only", () => {
    const args = parseArgs([
      "trigger",
      "--json",
      "guides",
      "--source",
      "/c.ts",
    ]);
    expect(args).toMatchObject({
      async: false,
      command: "trigger",
      config: "/c.ts",
      json: true,
      name: "guides",
    });
    for (const argv of [
      ["workspaces", "--input", "{}"],
      ["list", "--input", "{}"],
      ["settings", "--input", "{}"],
      ["tasks", "list", "--input", "{}"],
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
      ["trigger", "ask", "--input"],
      ["runs", "list", "--workspace"],
    ]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(
        `${argv.at(-1)} takes a value`
      );
    }
  });

  it("refuses a flag where --source or --input takes its value", () => {
    for (const command of [[], ["trigger", "ask"], ["start"]]) {
      expect(() => parseArgs([...command, "--source", "--json"])).toThrow(
        "--source takes a value, not the flag --json"
      );
    }
    expect(() => parseArgs(["--source", "--help"])).toThrow(
      "--source takes a value, not the flag --help"
    );
    expect(() => parseArgs(["trigger", "ask", "--input", "-h"])).toThrow(
      "trigger: --input takes a value, not the flag -h"
    );
  });
});

it("takes the last of repeated --source values", () => {
  expect(parseArgs(["--source", "old.ts", "--source", "new"]).config).toBe(
    "new"
  );
});

it("refuses removed and unknown commands with moved-command hints", () => {
  const refusals: [readonly string[], string][] = [
    [["bogus"], 'unknown command "bogus"'],
    [
      ["run", "ping"],
      'unknown command "run"; run is now marbles trigger <name>',
    ],
    [
      ["enqueue", "ping"],
      'unknown command "enqueue"; enqueue is now marbles trigger <name> --async',
    ],
    [
      ["roll", "ping"],
      'unknown command "roll"; roll is now marbles trigger <name>',
    ],
    [["status"], 'unknown command "status"; status is now marbles workspaces'],
    [["theme"], 'unknown command "theme"; theme is now marbles settings'],
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
    [["init"], 'unknown command "init"'],
    [["relink"], 'unknown command "relink"'],
    [["share", "run", "rn-1", "."], 'unknown command "share"'],
    [["unshare", "run", "rn-1", "."], 'unknown command "unshare"'],
    [["launchd", "install", "ping"], 'unknown command "launchd"'],
    [["list", "extra"], "list takes no arguments"],
    [["--harness", "foo"], "unknown option --harness"],
  ];
  for (const [argv, message] of refusals) {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(message);
  }
  expect(parseArgs(["bogus", "--help"]).command).toBe("help");
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
    sourceExplicit: true,
  });
  expect(() => parseArgs(["mcp", "list"])).toThrow("mcp takes no arguments");
  expect(() => parseArgs(["mcp", "--harness", "codex"])).toThrow(
    "mcp: unknown option --harness"
  );
  expect(parseArgs(["mcp", "--help"]).command).toBe("help");
});
