import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import {
  HELP,
  parseArguments,
  UsageError,
  workspacesOf,
} from "../../src/cli/args";

const REPOSITORY = resolve(import.meta.dirname, "../../../..");
/** The help block, which each page puts right after this heading. */
const HELP_BLOCKS = {
  "apps/atlas/README.md": "## Commands",
  "docs/atlas/reference/cli.md": "## Usage",
} as const;

function blockAfter(text: string, heading: string): string | undefined {
  const start = text.indexOf(`\n${heading}\n\n\`\`\`text\n`);
  if (start === -1) {
    return;
  }
  const body = text.indexOf("```text\n", start) + "```text\n".length;
  return text.slice(body, text.indexOf("```", body));
}

function usageError(argv: string[]): UsageError {
  try {
    parseArguments(argv, "/here");
  } catch (error) {
    if (error instanceof UsageError) {
      return error;
    }
    throw error;
  }
  throw new Error(`${argv.join(" ")} parsed without a usage error.`);
}

it("reads the default command with the current directory as its path, and only its own flags", () => {
  expect(parseArguments([], "/here")).toEqual({
    command: "open",
    history: false,
    json: false,
    "no-open": false,
    paths: ["/here"],
    port: undefined,
    quiet: false,
    state: undefined,
  });
  expect(
    parseArguments(["/there", "--no-open", "--port", "0", "--history"], "/here")
  ).toMatchObject({
    command: "open",
    history: true,
    "no-open": true,
    paths: ["/there"],
    port: 0,
  });
});

it("reads each command's positionals and flags", () => {
  expect(
    parseArguments(["scan", "/ws", "--json", "--quiet", "--state", "/s"], "/")
  ).toEqual({
    command: "scan",
    history: false,
    json: true,
    paths: ["/ws"],
    quiet: true,
    state: "/s",
  });
  expect(parseArguments(["serve", "--port", "0"], "/here")).toEqual({
    command: "serve",
    json: false,
    "no-open": false,
    paths: ["/here"],
    port: 0,
    quiet: false,
    state: undefined,
  });
  expect(parseArguments(["report", "@s/a"], "/here")).toEqual({
    command: "report",
    density: "normal",
    format: undefined,
    json: false,
    package: "@s/a",
    paths: ["/here"],
    quiet: false,
    state: undefined,
  });
  expect(
    parseArguments(
      ["report", "@s/a", "/ws", "--format", "markdown", "--density", "compact"],
      "/here"
    )
  ).toMatchObject({ density: "compact", format: "markdown", paths: ["/ws"] });
  expect(parseArguments(["lens", "domains"], "/here")).toEqual({
    command: "lens",
    density: "normal",
    format: undefined,
    json: false,
    lens: "domains",
    paths: ["/here"],
    quiet: false,
    state: undefined,
  });
  expect(
    parseArguments(
      [
        "lens",
        "placement",
        "/ws",
        "--format",
        "markdown",
        "--density",
        "compact",
      ],
      "/here"
    )
  ).toMatchObject({
    density: "compact",
    format: "markdown",
    lens: "placement",
    paths: ["/ws"],
  });
  expect(parseArguments(["check"], "/here")).toEqual({
    command: "check",
    density: "normal",
    format: undefined,
    json: false,
    paths: ["/here"],
    quiet: false,
    state: undefined,
  });
  expect(
    parseArguments(["check", "/ws", "--format", "markdown"], "/here")
  ).toMatchObject({ command: "check", format: "markdown", paths: ["/ws"] });
  const site = {
    opportunity: "internalize-symbol:packages/a/src/x.ts#X",
    place: "packages/a/src/x.ts#X",
    planId: "plan:internalize-symbol:packages/a/src/x.ts#X",
  };
  expect(parseArguments(["plan", "packages/a/src/x.ts#X"], "/here")).toEqual({
    command: "plan",
    density: "normal",
    format: undefined,
    json: false,
    paths: ["/here"],
    quiet: false,
    site,
    state: undefined,
  });
  for (const word of [site.opportunity, site.planId]) {
    expect(
      parseArguments(["plan", word, "/ws", "--json"], "/here")
    ).toMatchObject({ json: true, paths: ["/ws"], site });
  }
  expect(parseArguments(["apply", site.opportunity], "/here")).toEqual({
    command: "apply",
    density: "normal",
    format: undefined,
    json: false,
    paths: ["/here"],
    quiet: false,
    site,
    state: undefined,
    write: false,
  });
  expect(
    parseArguments(["apply", site.place, "/ws", "--write", "--json"], "/here")
  ).toMatchObject({ json: true, paths: ["/ws"], site, write: true });
  expect(parseArguments(["export", "site", "/ws"], "/here")).toEqual({
    command: "export",
    directory: "site",
    json: false,
    paths: ["/ws"],
    quiet: false,
    state: undefined,
  });
});

it("reads a command's name as a path when it is written as one", () => {
  expect(parseArguments(["./report"], "/here")).toMatchObject({
    command: "open",
    paths: ["./report"],
  });
  expect(parseArguments(["./lens"], "/here")).toMatchObject({
    command: "open",
    paths: ["./lens"],
  });
});

it("reads several paths for the commands that read a collection", () => {
  expect(parseArguments(["scan", "one", "two"], "/here")).toMatchObject({
    command: "scan",
    paths: ["one", "two"],
  });
  expect(parseArguments(["one", "two", "three"], "/here")).toMatchObject({
    command: "open",
    paths: ["one", "two", "three"],
  });
  expect(parseArguments(["serve", "one", "two"], "/here")).toMatchObject({
    command: "serve",
    paths: ["one", "two"],
  });
  expect(
    parseArguments(["export", "site", "one", "two"], "/here")
  ).toMatchObject({
    command: "export",
    directory: "site",
    paths: ["one", "two"],
  });
  expect(parseArguments(["export", "site"], "/here")).toMatchObject({
    paths: ["/here"],
  });
});

it("refuses a second path where a command reads one workspace's dataset", () => {
  for (const [argv, command] of [
    [["report", "@s/a", "one", "two"], "report"],
    [["lens", "domains", "one", "two"], "lens"],
    [["check", "one", "two"], "check"],
    [["plan", "a.ts#A", "one", "two"], "plan"],
    [["apply", "a.ts#A", "one", "two"], "apply"],
  ] as const) {
    expect(usageError([...argv]).message).toBe(
      `atlas ${command} reads one workspace's dataset; give one path.`
    );
  }
});

it("refuses a flag the command does not take", () => {
  expect(usageError(["serve", "--history"]).message).toBe(
    "atlas serve does not take --history."
  );
  expect(usageError(["scan", "--no-open"]).message).toBe(
    "atlas scan does not take --no-open."
  );
  expect(usageError(["report", "@s/a", "--port", "1"]).message).toBe(
    "atlas report does not take --port."
  );
  expect(usageError(["--format", "text"]).message).toBe(
    "atlas does not take --format."
  );
  expect(usageError(["export", "site", "--history"]).message).toBe(
    "atlas export does not take --history."
  );
  expect(usageError(["lens", "domains", "--history"]).message).toBe(
    "atlas lens does not take --history."
  );
  expect(usageError(["check", "--port", "1"]).message).toBe(
    "atlas check does not take --port."
  );
  expect(usageError(["plan", "a.ts#A", "--history"]).message).toBe(
    "atlas plan does not take --history."
  );
  // Writing is apply's, and only with --write.
  expect(usageError(["plan", "a.ts#A", "--write"]).message).toBe(
    "atlas plan does not take --write."
  );
  expect(usageError(["scan", "--write"]).message).toBe(
    "atlas scan does not take --write."
  );
});

it("refuses missing positionals and invalid values", () => {
  expect(usageError(["report"]).message).toBe(
    "atlas report needs a package: atlas report <package> [path...]"
  );
  expect(usageError(["export"]).message).toBe(
    "atlas export needs a directory: atlas export <dir> [path...]"
  );
  // There is no overview of every lens: an id is required.
  expect(usageError(["lens"]).message).toBe(
    "atlas lens needs a lens: atlas lens <id> [path...]"
  );
  expect(usageError(["lens", "domain"]).message).toBe(
    "atlas lens takes domains, file-roles, frequent-change, nesting, package-sizes, placement, proximity, responsibility-groups, or rules."
  );
  for (const port of ["65536", "-1", "1.5", "", "x"]) {
    expect(usageError(["serve", `--port=${port}`]).message).toBe(
      "Port must be an integer between 0 and 65535."
    );
  }
  expect(usageError(["report", "@s/a", "--format", "html"]).message).toBe(
    "--format takes terminal, text, or markdown."
  );
  expect(usageError(["report", "@s/a", "--density", "full"]).message).toBe(
    "--density takes compact, normal, or expanded."
  );
  expect(
    usageError(["report", "@s/a", "--json", "--format", "text"]).message
  ).toBe("--json prints the report as saved; drop --format and --density.");
  expect(
    usageError(["lens", "domains", "--json", "--density", "compact"]).message
  ).toBe("--json prints the lens as saved; drop --format and --density.");
  expect(usageError(["check", "--json", "--format", "text"]).message).toBe(
    "--json prints the check's result; drop --format and --density."
  );
  expect(usageError(["plan"]).message).toBe(
    "atlas plan needs an opportunity: atlas plan <opportunity> [path...]"
  );
  expect(usageError(["apply", "--write"]).message).toBe(
    "atlas apply needs an opportunity: atlas apply <opportunity> [path...]"
  );
  expect(usageError(["apply", "fold-package:@s/a"]).message).toContain(
    "names no internalize opportunity"
  );
  expect(usageError(["plan", "fold-package:@s/a"]).message).toBe(
    "fold-package:@s/a names no internalize opportunity. Write internalize-symbol:<path#name>, its plan id, or <path#name>."
  );
  expect(
    usageError(["plan", "a.ts#A", "--json", "--format", "text"]).message
  ).toBe("--json prints the plan's result; drop --format and --density.");
});

it("checks for unknown flags first, then lets --help win over the rest", () => {
  expect(usageError(["--unknown"]).message).toContain("--unknown");
  expect(usageError(["--help", "--unknown"]).message).toContain("--unknown");
  expect(parseArguments(["--help"], "/here")).toEqual({ command: "help" });
  expect(parseArguments(["serve", "--history", "-h"], "/here")).toEqual({
    command: "help",
  });
  expect(parseArguments(["scan", "a", "b", "--help"], "/here")).toEqual({
    command: "help",
  });
});

it("generates the help from the command table", () => {
  expect(HELP).toContain("  atlas report <package> [path...]");
  expect(HELP).toContain("  atlas lens <id> [path...]");
  expect(HELP).toContain("  atlas export <dir> [path...]");
  expect(HELP).toContain("  atlas check [path...]");
  expect(HELP).toContain(
    "  atlas plan <opportunity> [path...]   Plan one opportunity and authorize it; writes nothing in the workspace"
  );
  expect(HELP).toContain("report, lens, check, plan, apply: ");
  expect(HELP).toContain(
    "  atlas apply <opportunity> [path...]  Preview a planned change; write and verify it with --write"
  );
  expect(HELP).toContain(
    "  --write               apply: write the change, verify it, then scan again"
  );
  expect(HELP).toContain("atlas, serve: ");
  expect(HELP).toContain(
    "Exit codes: 0 done, 1 failed, 2 bad arguments, 3 a rule broken (check)."
  );
  expect(HELP.split("\n")[0]).toBe(
    "Atlas — workspace analysis and a local viewer"
  );
});

it("is the help the CLI reference and the README print", () => {
  for (const [page, heading] of Object.entries(HELP_BLOCKS)) {
    const text = readFileSync(resolve(REPOSITORY, page), "utf8");
    expect(blockAfter(text, heading), page).toBe(HELP);
  }
});

it("reads one path as one workspace, as given, and several distinct ones as a collection", async () => {
  expect(await workspacesOf(["/not/resolved/yet"])).toEqual({
    root: "/not/resolved/yet",
  });
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "atlas-args-")));
  try {
    const [a, b] = ["a", "b"].map((name) => join(directory, name));
    for (const root of [a, b]) {
      mkdirSync(root as string);
    }
    const link = join(directory, "link");
    symlinkSync(a as string, link);
    expect(await workspacesOf([b as string, a as string])).toEqual({
      roots: [b, a],
    });
    const twice = workspacesOf([a as string, b as string, link]);
    await expect(twice).rejects.toBeInstanceOf(UsageError);
    await expect(twice).rejects.toThrow(
      `${link} names the same workspace as ${a}, ${a}; give each workspace once.`
    );
    const nested = join(a as string, "packages", "nested");
    mkdirSync(nested, { recursive: true });
    const overlapping = workspacesOf([nested, b as string, a as string]);
    await expect(overlapping).rejects.toBeInstanceOf(UsageError);
    await expect(overlapping).rejects.toThrow(
      `Workspace ${a} holds workspace ${nested}; the workspaces of a collection cannot overlap.`
    );
    const missing = [join(directory, "z"), join(directory, "y")];
    await expect(workspacesOf([a as string, ...missing])).rejects.toThrow(
      `Workspace path does not exist: ${missing[0]}`
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
