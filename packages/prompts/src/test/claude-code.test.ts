import { describe, expect, it } from "vitest";

import { assemble, claudeCode, Parser, prompts } from "..";

const parser = new Parser(claudeCode);
const LONG_PUNCTUATION_RUN = 50_000;
const EMPTY_SHELL_MARKERS = 120_000;
// A quadratic pass over these inputs takes seconds; the budget leaves room for
// a slow machine.
const LINEAR_TIME_BUDGET_MS = 1000;
const template = assemble({
  dialects: { claude: claudeCode },
  surface: "template",
});

function kinds(text: string): string[] {
  return parser
    .tokenize(text)
    .filter((token) => token.kind !== "text")
    .map((token) => `${token.kind}:${token.text}`);
}

describe("claude-code dialect", () => {
  it("reads a skill invocation with its arguments when it opens the message", () => {
    const prompt = prompts.claude("/code-review ultra 123");
    expect(prompt.references).toEqual([
      expect.objectContaining({
        arguments: "ultra 123",
        kind: "skill",
        name: "code-review",
      }),
    ]);
    expect(prompt.tokens[0]?.text).toBe("/code-review");
  });

  it("reads a skill named anywhere in the text, and plugin namespaces", () => {
    expect(kinds("Then run /design:critique on it.")).toEqual([
      "skill:/design:critique",
    ]);
    const [reference] = prompts.claude("use /design:critique").references;
    expect(reference).toMatchObject({ kind: "skill", name: "design:critique" });
    expect(reference).not.toHaveProperty("arguments");
  });

  it("labels a built-in that opens the message as a command, elsewhere as a skill", () => {
    expect(kinds("/clear")).toEqual(["command:/clear"]);
    expect(kinds("please /clear it")).toEqual(["skill:/clear"]);
  });

  it("mentions files and folders, keeping sentence punctuation out of the path", () => {
    expect(kinds("Explain @src/auth.ts, then @src/components/.")).toEqual([
      "file:@src/auth.ts",
      "file:@src/components/",
    ]);
    expect(prompts.claude("look at @src/auth.ts.").references[0]).toMatchObject(
      { kind: "file", path: "src/auth.ts" }
    );
    expect(kinds("@.")).toEqual([]);
  });

  it("trims a long run of punctuation after a mention in linear time", () => {
    const dots = ".".repeat(LONG_PUNCTUATION_RUN);
    const started = performance.now();
    const bare = kinds(`@${dots}`);
    const ended = kinds(`@${dots}a`);
    const elapsed = performance.now() - started;
    expect(bare).toEqual([]);
    expect(ended).toEqual([`file:@${dots}a`]);
    expect(elapsed).toBeLessThan(LINEAR_TIME_BUDGET_MS);
  });

  it("mentions a subagent in its quoted form", () => {
    const prompt = prompts.claude(
      '@"code-reviewer (agent)" look at the changes'
    );
    expect(prompt.references).toEqual([
      expect.objectContaining({ kind: "agent", name: "code-reviewer" }),
    ]);
    expect(prompt.tokens[0]?.text).toBe('@"code-reviewer (agent)"');
  });

  it("reads argument placeholders, variables, and inline shell in a template", () => {
    const prompt = template.claude(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: harness variable syntax, not a JS placeholder.
      "Migrate $ARGUMENTS[0] from $1 to $target in ${CLAUDE_SKILL_DIR}. Diff: !`gh pr diff` and $ARGUMENTS."
    );
    expect(prompt.references.map((reference) => reference.kind)).toEqual([
      "argument",
      "argument",
      "argument",
      "variable",
      "shell",
      "argument",
    ]);
    expect(prompt.references[0]).toMatchObject({
      selector: { by: "position", index: 0 },
    });
    expect(prompt.references[1]).toMatchObject({
      selector: { by: "position", index: 1 },
    });
    expect(prompt.references[2]).toMatchObject({
      selector: { by: "name", name: "target" },
    });
    expect(prompt.references[3]).toMatchObject({ name: "CLAUDE_SKILL_DIR" });
    expect(prompt.references[4]).toMatchObject({ command: "gh pr diff" });
    expect(prompt.references[5]).toMatchObject({ selector: { by: "all" } });
    expect(prompt.diagnostics).toEqual([]);
  });

  it("warns when template-only notation appears in a message", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: harness variable syntax, not a JS placeholder.
    const prompt = prompts.claude("Log $ARGUMENTS to ${CLAUDE_SESSION_ID}");
    expect(prompt.diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ["template-only", "warning"],
      ["template-only", "warning"],
    ]);
    expect(prompt.ok).toBe(true);
  });

  it("flags a variable the harness does not provide", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: harness variable syntax, not a JS placeholder.
    const prompt = template.claude("${NOPE}");
    expect(prompt.diagnostics[0]).toMatchObject({
      code: "unresolved-reference",
      severity: "error",
    });
    expect(prompt.ok).toBe(false);
  });

  it("warns that a command is consumed by the harness", () => {
    expect(prompts.claude("/clear").diagnostics.map((d) => d.code)).toEqual([
      "consumed-by-harness",
    ]);
  });

  it("ignores sigils that are not at a boundary", () => {
    expect(
      kinds(
        "mail me@example.com about a/b tests, US$5, https://x.io/y, /usr/bin"
      )
    ).toEqual([]);
  });

  it("requires inline shell to close on the same line", () => {
    expect(kinds("!`unterminated\n`")).toEqual([]);
    expect(kinds("!`a\nb` then !`ok`")).toEqual(["shell:!`ok`"]);
    expect(kinds("!` ` !`date`")).toEqual(["shell:!`date`"]);
  });

  it("passes over many empty inline shell markers in linear time", () => {
    const markers = "!` ` ".repeat(EMPTY_SHELL_MARKERS);
    const started = performance.now();
    const found = kinds(`${markers}\n!\`date\``);
    const elapsed = performance.now() - started;
    expect(found).toEqual(["shell:!`date`"]);
    expect(elapsed).toBeLessThan(LINEAR_TIME_BUDGET_MS);
  });
});
