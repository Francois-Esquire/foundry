import { describe, expect, it } from "vitest";

import { codex, Parser, prompts } from "..";

const parser = new Parser(codex);

function kinds(text: string): string[] {
  return parser
    .tokenize(text)
    .filter((token) => token.kind !== "text")
    .map((token) => `${token.kind}:${token.text}`);
}

describe("codex dialect", () => {
  it("mentions skills with $ anywhere, including plugin namespaces", () => {
    expect(prompts.codex("use $slack:search and $alpha").references).toEqual([
      expect.objectContaining({ kind: "skill", name: "slack:search" }),
      expect.objectContaining({ kind: "skill", name: "alpha" }),
    ]);
  });

  it("invokes a custom prompt with /prompts: and keeps its arguments", () => {
    const prompt = prompts.codex(
      '/prompts:draftpr FILES="src/a.ts src/b.ts" PR_TITLE="Add hero"'
    );
    expect(prompt.references).toEqual([
      expect.objectContaining({
        arguments: 'FILES="src/a.ts src/b.ts" PR_TITLE="Add hero"',
        kind: "template",
        name: "draftpr",
      }),
    ]);
    expect(prompt.tokens[0]?.text).toBe("/prompts:draftpr");
  });

  it("treats /name at the start as a command and validates it against the built-ins", () => {
    expect(prompts.codex("/review").ok).toBe(true);
    const unknown = prompts.codex("/nope");
    expect(unknown.diagnostics.map((d) => d.code)).toEqual([
      "consumed-by-harness",
      "unresolved-reference",
    ]);
    expect(kinds("not /review here")).toEqual([]);
  });

  it("separates placeholders from skill mentions by shape", () => {
    const prompt = prompts.codex(
      "Stage $FILES then $1 and $ARGUMENTS, $ARGUMENTS[2]; use $review-skill"
    );
    expect(prompt.references.map((r) => r.kind)).toEqual([
      "argument",
      "argument",
      "argument",
      "argument",
      "skill",
    ]);
    expect(prompt.references[0]).toMatchObject({
      selector: { by: "name", name: "FILES" },
    });
  });

  it("tokenizes $$ as an escape, never as a sigil", () => {
    expect(kinds("costs $$5 and $$alpha")).toEqual(["escape:$$", "escape:$$"]);
    expect(prompts.codex("$$alpha").references).toEqual([]);
  });

  it("mentions files with @", () => {
    expect(kinds("Read @foo.ts @schema.ts and explain")).toEqual([
      "file:@foo.ts",
      "file:@schema.ts",
    ]);
  });

  it("reads a leading ! as a shell command the harness runs itself", () => {
    const prompt = prompts.codex("!ls -la");
    expect(prompt.references).toEqual([
      expect.objectContaining({ command: "ls -la", kind: "shell" }),
    ]);
    expect(prompt.diagnostics.map((d) => d.code)).toEqual([
      "consumed-by-harness",
    ]);
    expect(kinds("run it!ls")).toEqual([]);
  });

  it("has no notation for an agent mention", () => {
    expect(codex.write({ kind: "agent", name: "reviewer" })).toBeNull();
  });
});
