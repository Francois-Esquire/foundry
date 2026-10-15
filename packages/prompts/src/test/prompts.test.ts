import { describe, expect, it } from "vitest";

import {
  assemble,
  claudeCode,
  codex,
  Dialect,
  HIGHLIGHT_SCOPES,
  notation,
  Parser,
  Prompt,
  PromptError,
  pi,
  prompts,
  ref,
} from "..";

const PROMPT_SCOPE = /\.prompt$/;

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("authoring out of the box", () => {
  it("returns a prompt whose text is what the harness receives", () => {
    const target = "src/auth";
    const review = prompts.claude`Review @${target} with /code-review.`;
    expect(review).toBeInstanceOf(Prompt);
    expect(review.text).toBe("Review @src/auth with /code-review.");
    expect(String(review)).toBe(review.text);
    expect(review.references.map((r) => r.kind)).toEqual(["file", "skill"]);
    expect(review.dialect).toBe(claudeCode);
    expect(review.diagnostics).toEqual([]);
    expect(review.ok).toBe(true);
  });

  it("authors from plain text too", () => {
    const review = prompts.codex("use $review");
    expect(review.references[0]).toMatchObject({
      kind: "skill",
      name: "review",
    });
    expect(prompts.pi.dialect).toBe(pi);
  });

  it("writes a typed reference in each dialect's own notation", () => {
    const skill = ref.skill("code-review");
    expect(prompts.claude`Use ${skill}.`.text).toBe("Use /code-review.");
    expect(prompts.codex`Use ${skill}.`.text).toBe("Use $code-review.");
    expect(prompts.pi`${skill}`.text).toBe("/skill:code-review");
    expect(prompts.claude`${ref.agent("reviewer")} go`.text).toBe(
      '@"reviewer (agent)" go'
    );
    expect(
      prompts.claude`${ref.argument(1)} ${ref.argument("name")}`.text
    ).toBe("$1 $name");
    expect(prompts.codex`${ref.argument()}`.text).toBe("$ARGUMENTS");
    expect(prompts.claude`${ref.variable("CLAUDE_SKILL_DIR")}`.text).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: harness variable syntax, not a JS placeholder.
      "${CLAUDE_SKILL_DIR}"
    );
  });

  it("warns when a dialect cannot write a reference", () => {
    const ask = prompts.codex`Ask ${ref.agent("reviewer")} to look.`;
    expect(ask.text).toBe("Ask reviewer to look.");
    expect(ask.diagnostics).toEqual([
      expect.objectContaining({
        code: "unsupported-reference",
        severity: "warning",
        span: { end: 12, start: 4 },
      }),
    ]);
    expect(ask.ok).toBe(true);
  });

  it("uses cooked strings so \\${ writes a literal substitution", () => {
    const run = prompts.claude`Run \${CLAUDE_SKILL_DIR}/x and !\`git status\``;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: harness variable syntax, not a JS placeholder.
    expect(run.text).toBe("Run ${CLAUDE_SKILL_DIR}/x and !`git status`");
    expect(run.references.map((r) => r.kind)).toEqual(["variable", "shell"]);
  });
});

describe("what exists", () => {
  it("reports unresolved references for covered kinds only", () => {
    const mine = assemble({
      dialects: { claude: claudeCode },
      sources: [{ agent: ["reviewer"], skill: (name) => name === "review" }],
    });
    expect(mine.claude`/review then @"reviewer (agent)" @any/file`.ok).toBe(
      true
    );
    const bad = mine.claude`/nope then @"nobody (agent)"`;
    expect(bad.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ["unresolved-reference", 'Unknown skill "nope".'],
      ["unresolved-reference", 'Unknown agent "nobody".'],
    ]);
    expect(bad.ok).toBe(false);
  });

  it("reads diagnostics live, so a source added later resolves an earlier prompt", () => {
    const mine = assemble({
      dialects: { claude: claudeCode },
      sources: [{ skill: ["review"] }],
    });
    const later = mine.claude`/review and /lint`;
    expect(later.ok).toBe(false);
    mine.add({ skill: ["lint"] });
    expect(later.ok).toBe(true);
  });

  it("reads a listed iterable once and a predicate live", () => {
    const names = new Set(["a"]);
    const listed = assemble({ dialects: {}, sources: [{ skill: names }] });
    const live = assemble({
      dialects: {},
      sources: [{ skill: (name) => names.has(name) }],
    });
    names.add("b");
    expect(listed.has("skill", "b")).toBe(false);
    expect(live.has("skill", "b")).toBe(true);
  });

  it("resolves when any layer has the name and covers when any layer covers the kind", () => {
    const mine = assemble({
      dialects: {},
      sources: [{ skill: ["a"] }, { file: ["x.ts"], skill: ["b"] }],
    });
    expect(mine.covers("skill")).toBe(true);
    expect(mine.covers("file")).toBe(true);
    expect(mine.covers("agent")).toBe(false);
    expect(mine.has("skill", "a")).toBe(true);
    expect(mine.has("skill", "b")).toBe(true);
    expect(mine.has("skill", "c")).toBe(false);
  });

  it("extends a harness's built-in commands", () => {
    expect(prompts.codex`/mine`.ok).toBe(false);
    const mine = assemble({
      dialects: { codex },
      sources: [{ command: ["mine"] }],
    });
    expect(mine.codex`/mine`.ok).toBe(true);
  });

  it("merges authoring diagnostics with checking, ordered by position", () => {
    const mine = assemble({ dialects: { codex }, sources: [{ skill: [] }] });
    const mixed = mine.codex`$nope ${ref.agent("x")}`;
    expect(mixed.diagnostics.map((d) => d.code)).toEqual([
      "unresolved-reference",
      "unsupported-reference",
    ]);
  });

  it("reads prompts on the template surface when assembled for it", () => {
    const template = assemble({
      dialects: { claude: claudeCode },
      surface: "template",
    });
    expect(prompts.claude`$ARGUMENTS`.diagnostics[0]).toMatchObject({
      code: "template-only",
    });
    expect(template.claude`$ARGUMENTS`.diagnostics).toEqual([]);
    expect(template.claude`$ARGUMENTS`.surface).toBe("template");
  });
});

describe("strict", () => {
  it("throws from the tag when anything referenced is not present", () => {
    const strict = assemble({
      dialects: { claude: claudeCode },
      sources: [{ skill: ["review"] }],
      strict: true,
    });
    expect(strict.claude`/review`.ok).toBe(true);
    expect(() => strict.claude`/review then /nope`).toThrow(PromptError);
    const error = thrown(() => strict.claude`/nope`);
    expect(error).toBeInstanceOf(PromptError);
    const failure = error as PromptError;
    expect(failure.message).toBe(
      'Claude Code prompt has 1 error: Unknown skill "nope".'
    );
    expect(failure.prompt.text).toBe("/nope");
    expect(failure.diagnostics[0]?.code).toBe("unresolved-reference");
  });

  it("does not throw on warnings", () => {
    const strict = assemble({ dialects: { codex }, strict: true });
    expect(strict.codex`$ARGUMENTS ${ref.agent("x")}`.ok).toBe(true);
  });

  it("can be switched on the out-of-the-box instance", () => {
    const mine = assemble({ dialects: { codex }, sources: [{ skill: [] }] });
    expect(mine.codex`$nope`.ok).toBe(false);
    mine.strict = true;
    expect(() => mine.codex`$nope`).toThrow(PromptError);
    mine.strict = false;
  });
});

describe("foreign notation", () => {
  const mine = assemble({
    dialects: { claude: claudeCode, codex, pi },
    sources: [{ agent: ["reviewer"], skill: ["review"] }],
  });

  it("reports a known skill written with another dialect's sigil, with the right spelling", () => {
    const wrong = mine.claude`Please $review this`;
    expect(wrong.diagnostics).toEqual([
      expect.objectContaining({
        code: "foreign-notation",
        message:
          '"$review" is Codex notation; Claude Code reads a skill as "/review".',
        severity: "error",
        span: { end: 14, start: 7 },
      }),
    ]);
    expect(wrong.ok).toBe(false);
    expect(mine.codex`Please /skill:review this`.ok).toBe(true);
    expect(mine.codex`/skill:review this`.diagnostics[0]).toMatchObject({
      code: "foreign-notation",
      message:
        '"/skill:review" is Pi notation; Codex reads a skill as "$review".',
    });
  });

  it("says when the own dialect has no notation for the kind", () => {
    expect(mine.codex`ask @"reviewer (agent)"`.diagnostics[0]?.message).toBe(
      '"@"reviewer (agent)"" is Claude Code notation; Codex has no notation for a agent.'
    );
  });

  it("stays quiet for names the host does not have and for agreeing readings", () => {
    expect(mine.claude`costs $5 and $unknown; see @src/x`.ok).toBe(true);
    expect(mine.claude`/review`.ok).toBe(true);
    expect(mine.pi`/skill:review now`.ok).toBe(true);
    expect(prompts.claude`$review`.ok).toBe(true);
  });
});

describe("assembling", () => {
  it("makes a tag per named dialect, including a composed one", () => {
    const custom = new Dialect({
      id: "custom",
      label: "Custom",
      notations: [
        notation.invocation({ id: "custom/skill", kind: "skill", sigil: "#" }),
        ...claudeCode.notations.filter((n) => n.kind === "file"),
      ],
    });
    const mine = assemble({
      dialects: { claude: claudeCode, custom },
      sources: [{ skill: ["review"] }],
    });
    const use = mine.custom`Use #review on @src/.`;
    expect(use.references).toEqual([
      expect.objectContaining({ kind: "skill", name: "review" }),
      expect.objectContaining({ kind: "file", path: "src/" }),
    ]);
    expect(use.ok).toBe(true);
    expect(mine.custom`#nope`.ok).toBe(false);
    expect(mine.claude`/review`.ok).toBe(true);
    expect(custom.write(ref.skill("review"))).toBe("#review");
  });

  it("refuses a dialect named after a utility", () => {
    expect(() => assemble({ dialects: { add: claudeCode } })).toThrow(
      '"add" is reserved on prompts; name the dialect something else.'
    );
  });
});

describe("tokens", () => {
  it("cover the whole text contiguously", () => {
    const text = "/review @a.ts then $x and plain";
    const tokens = new Parser(claudeCode).tokenize(text);
    expect(tokens[0]?.span.start).toBe(0);
    expect(tokens.at(-1)?.span.end).toBe(text.length);
    for (const [index, token] of tokens.entries()) {
      const previous = tokens[index - 1];
      if (previous) {
        expect(token.span.start).toBe(previous.span.end);
      }
      expect(text.slice(token.span.start, token.span.end)).toBe(token.text);
    }
  });

  it("map every kind to a highlight scope", () => {
    for (const token of new Parser(claudeCode).tokenize("/x @y $z")) {
      expect(HIGHLIGHT_SCOPES[token.kind]).toMatch(PROMPT_SCOPE);
    }
  });
});

describe("removing a source", () => {
  it("takes a source out by identity", () => {
    const skills = {
      covers: (kind: string) => kind === "skill",
      has: () => false,
    };
    const mine = assemble({ dialects: { claude: claudeCode } });
    mine.add(skills);
    const check = mine.claude`/lint`;
    expect(check.ok).toBe(false);
    expect(mine.remove(skills)).toBe(true);
    expect(check.ok).toBe(true);
    expect(mine.remove(skills)).toBe(false);
  });
});
