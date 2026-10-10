import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { HELP, parseArguments, UsageError } from "../../src/cli/args";

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

it("refuses a second path, naming the collection work", () => {
  expect(usageError(["scan", "one", "two"]).message).toBe(
    "atlas scan takes one workspace path. Reading several workspaces at once is not supported yet."
  );
  expect(usageError(["one", "two"]).message).toBe(
    "atlas takes one workspace path. Reading several workspaces at once is not supported yet."
  );
  expect(usageError(["report", "@s/a", "one", "two"]).message).toContain(
    "atlas report takes one workspace path."
  );
  expect(usageError(["lens", "domains", "one", "two"]).message).toContain(
    "atlas lens takes one workspace path."
  );
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
    "atlas lens takes domains, file-roles, frequent-change, nesting, package-sizes, placement, proximity, or responsibility-groups."
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
  expect(HELP).toContain("report, lens: ");
  expect(HELP).toContain("atlas, serve: ");
  expect(HELP).toContain("Exit codes: 0 done, 1 failed, 2 bad arguments.");
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
