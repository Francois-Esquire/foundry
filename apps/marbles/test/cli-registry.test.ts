import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineCommand } from "~/cli/command";
import type { CliIo } from "~/cli/context";
import { COMMAND_LIST, COMMANDS, formatHelp, runCli } from "~/cli/index";
import { temporaryDirectory } from "./helpers/temporary";

const cliDir = fileURLToPath(new URL("../src/cli/", import.meta.url));
const SOURCE_FILE = /\.tsx?$/;

function captureIo(): {
  readonly io: CliIo;
  readonly stderr: () => string;
  readonly stdout: () => string;
} {
  let out = "";
  let err = "";
  return {
    io: {
      diagnose(line) {
        err += `${line}\n`;
      },
      print(line) {
        out += `${line}\n`;
      },
      stderr(text) {
        err += text;
      },
      stdout(text) {
        out += text;
      },
    },
    stderr: () => err,
    stdout: () => out,
  };
}

function topLevelImports(path: string, text: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true
  );
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

describe("CLI command registry and help generation", () => {
  const previousExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = previousExitCode;
    vi.unstubAllEnvs();
  });

  it("registers every command once with consistent keys and valid groups", () => {
    const names = COMMAND_LIST.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(Object.keys(COMMANDS).sort());
    for (const command of COMMAND_LIST) {
      expect(COMMANDS[command.name]).toBe(command);
      expect(["core", "resources", "system"]).toContain(command.group);
      expect(command.summary.length).toBeGreaterThan(0);
    }
    expect(COMMANDS.tasks.group).toBe("resources");
    expect(COMMANDS.workspaces.group).toBe("resources");
    for (const removed of [
      "daemon",
      "init",
      "run",
      "enqueue",
      "status",
      "theme",
    ]) {
      expect(Object.hasOwn(COMMANDS, removed), removed).toBe(false);
    }
    for (const kept of [
      "trigger",
      "watch",
      "workspaces",
      "tasks",
      "settings",
      "start",
      "stop",
      "mcp",
    ]) {
      expect(Object.hasOwn(COMMANDS, kept), kept).toBe(true);
    }
  });

  it("auto-generates help from registered command metadata with only global --source, --json, and --help", () => {
    const help = formatHelp();
    expect(help).toContain("marbles — programmable workspace automation");
    expect(help).toContain("Core:");
    expect(help).toContain("Resources (");
    expect(help).toContain("System:");
    expect(help).toContain("Flags:");
    expect(help).toContain("--source <path>");
    expect(help).toContain("--json");
    expect(help).toContain("Tasks, the workspace backlog");
    for (const command of COMMAND_LIST) {
      const firstUsage =
        typeof command.usage === "string"
          ? command.usage
          : (command.usage[0]?.command ?? "");
      expect(help, command.name).toContain(firstUsage);
    }
    expect(help).toContain("stop --workspace");
    expect(help).toContain("trigger <name> --async");
    expect(help).not.toContain("daemon");
    expect(help).not.toContain("relink");
    expect(help).not.toContain("share <id>");
    expect(help).not.toContain("--dry-run");
    expect(help).not.toContain("--recheck-providers");
    expect(help).not.toContain("--expect");
    expect(help).not.toContain("--cursor");
    expect(help).not.toContain("--any-tag");
    expect(help).not.toContain("--metadata");
  });

  it("generates help dynamically for custom command lists via defineCommand", () => {
    const custom = defineCommand({
      details: "Custom details block.",
      group: "core",
      name: "ping",
      needs: "none",
      parse: () => ({}),
      run: () => undefined,
      summary: "check connectivity",
      usage: "ping",
    });
    const rendered = formatHelp([custom]);
    expect(rendered).toContain("Core:\n  ping");
    expect(rendered).toContain("check connectivity");
    expect(rendered).toContain("Custom details block.");
    expect(rendered).not.toContain("System:");
  });

  it("keeps src/cli/ free of top-level React, OpenTUI, and ~/tui imports", async () => {
    const files = await readdir(cliDir, { recursive: true });
    const violations: string[] = [];
    for (const file of files.filter((name) => SOURCE_FILE.test(name))) {
      const fullPath = resolve(cliDir, file);
      const text = await readFile(fullPath, "utf8");
      for (const specifier of topLevelImports(fullPath, text)) {
        if (
          specifier === "react" ||
          specifier.startsWith("react/") ||
          specifier.startsWith("@opentui/") ||
          specifier === "~/tui" ||
          specifier.startsWith("~/tui/")
        ) {
          violations.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("runs commands in both formatted text and top-level --json modes through runCli", async () => {
    const home = temporaryDirectory("marbles-cli-json-");
    vi.stubEnv("FOUNDRY_ROOT", home);

    const help = captureIo();
    await runCli(["--help"], undefined, { interactive: false, io: help.io });
    expect(help.stdout()).toContain(
      "marbles — programmable workspace automation"
    );
    expect(help.stderr()).toBe("");
    expect(process.exitCode).toBe(previousExitCode);

    const settingsJson = captureIo();
    await runCli(["--json", "settings"], undefined, {
      interactive: false,
      io: settingsJson.io,
    });
    expect(JSON.parse(settingsJson.stdout())).toEqual({ theme: "dark" });

    const workspacesJson = captureIo();
    await runCli(["workspaces", "--json"], undefined, {
      interactive: true,
      io: workspacesJson.io,
    });
    expect(JSON.parse(workspacesJson.stdout())).toMatchObject({
      process: null,
      workspaces: [],
    });

    const stopJson = captureIo();
    await runCli(["stop", "--json"], undefined, {
      interactive: false,
      io: stopJson.io,
    });
    expect(JSON.parse(stopJson.stdout())).toEqual({ stopped: false });

    const refused = captureIo();
    await runCli(["watch", "rn-1", "--json"], undefined, {
      interactive: false,
      io: refused.io,
    });
    expect(refused.stderr()).toContain("watch does not support --json");
    expect(process.exitCode).toBe(1);
  });
});
