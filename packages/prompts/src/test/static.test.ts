import { describe, expect, it } from "vitest";

import {
  assemble,
  check,
  claudeCode,
  codex,
  cookedToRaw,
  Dialect,
  notation,
  Parser,
  prompts,
  REFERENCE,
  type Referenceable,
  ref,
  referenceOf,
} from "..";

describe("references by symbol", () => {
  const reviewer: Referenceable<"agent"> = {
    [REFERENCE]: () => ({ kind: "agent", name: "reviewer" }),
  };

  it("writes a value implementing the protocol in the dialect's notation", () => {
    const ask = prompts.claude`Ask ${reviewer} to look at @src/`;
    expect(ask.text).toBe('Ask @"reviewer (agent)" to look at @src/');
    expect(ask.references.map((r) => [r.kind, r.origin])).toEqual([
      ["agent", "symbol"],
      ["file", "text"],
    ]);
  });

  it("checks a symbolic reference against sources like any other", () => {
    const mine = assemble({
      dialects: { claude: claudeCode },
      sources: [{ agent: ["reviewer"] }],
    });
    expect(mine.claude`${reviewer}`.ok).toBe(true);
    expect(mine.claude`${ref.agent("nobody")}`.diagnostics[0]?.code).toBe(
      "unresolved-reference"
    );
  });

  it("tells references from plain values", () => {
    expect(referenceOf(reviewer)).toEqual({ kind: "agent", name: "reviewer" });
    expect(referenceOf(ref.skill("x"))).toEqual({ kind: "skill", name: "x" });
    expect(referenceOf("text")).toBeNull();
    expect(referenceOf(3)).toBeNull();
    expect(referenceOf({} as never)).toBeNull();
    expect(referenceOf(true as never)).toBeNull();
    expect(referenceOf(null as never)).toBeNull();
    expect(referenceOf({ kind: 1 } as never)).toBeNull();
  });

  it("inserts a prompt as its text and reads its references from the text", () => {
    const inner = prompts.claude`look at @src/a.ts`;
    const outer = prompts.claude`Use ${inner}`;
    expect(outer.text).toBe("Use look at @src/a.ts");
    expect(outer.diagnostics).toEqual([]);
    expect(outer.references).toEqual([
      expect.objectContaining({
        kind: "file",
        origin: "text",
        path: "src/a.ts",
      }),
    ]);
  });

  it("writes a value that is not a reference as plain text", () => {
    expect(prompts.claude`Use ${{ a: 1 } as never}`.text).toBe(
      "Use [object Object]"
    );
    expect(prompts.claude`Is ${true as never}`.text).toBe("Is true");
    expect(prompts.claude`Is ${true as never}`.diagnostics).toEqual([]);
  });
});

describe("reading a template statically", () => {
  const parser = new Parser(claudeCode);

  it("keeps a hole per interpolation and never spans one", () => {
    const tokens = parser.tokenizeTemplate(["Review @", " with /review"]);
    expect(tokens.map((t) => [t.kind, t.text])).toEqual([
      ["text", "Review @"],
      ["hole", ""],
      ["text", " with "],
      ["skill", "/review"],
    ]);
    expect(tokens[1]?.span).toEqual({ end: 8, start: 8 });
    expect(tokens.at(-1)?.span).toEqual({ end: 21, start: 14 });
  });

  it("offers message start only to the first chunk", () => {
    const tokens = parser.tokenizeTemplate(["", "/clear"]);
    expect(tokens.map((t) => t.kind)).toEqual(["hole", "skill"]);
    expect(parser.tokenizeTemplate(["/clear", ""]).map((t) => t.kind)).toEqual([
      "command",
      "hole",
    ]);
  });
});

describe("cookedToRaw", () => {
  it("maps through escapes", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: raw template source under test.
    const raw = "a\\${b}\\`c\\n\\u0041\\u{1F600}d";
    const toRaw = cookedToRaw(raw);
    // cooked: a ${b} ` c \n A 😀 d
    expect(toRaw(0)).toBe(0); // a
    expect(toRaw(1)).toBe(1); // $ ← "\$"
    expect(toRaw(2)).toBe(3); // {
    expect(toRaw(5)).toBe(6); // ` ← "\`"
    expect(toRaw(6)).toBe(8); // c
    expect(toRaw(7)).toBe(9); // newline ← "\n"
    expect(toRaw(8)).toBe(11); // A ← "A"
    expect(toRaw(9)).toBe(17); // 😀 high surrogate ← "\u{1F600}"
    expect(toRaw(10)).toBe(17); // 😀 low surrogate
    expect(toRaw(11)).toBe(26); // d
    expect(toRaw(12)).toBe(raw.length); // end maps to end
  });

  it("drops a line continuation and clamps out-of-range offsets", () => {
    const toRaw = cookedToRaw("ab\\\ncd");
    expect(toRaw(2)).toBe(4); // c
    expect(toRaw(-1)).toBe(0);
    expect(toRaw(99)).toBe(6);
  });

  it("returns for a \\u{ that never closes, mapping monotonically", () => {
    const raw = "\\u{41 and more";
    const toRaw = cookedToRaw(raw);
    // `\u` is read as a plain escape: cooked `u{41 and more`.
    expect(toRaw(0)).toBe(0);
    expect(toRaw(1)).toBe(2); // {
    let previous = toRaw(0);
    for (let cooked = 1; cooked <= raw.length; cooked += 1) {
      const mapped = toRaw(cooked);
      expect(mapped).toBeGreaterThanOrEqual(previous);
      previous = mapped;
    }
    expect(toRaw(raw.length)).toBe(raw.length);
  });

  it("stays finite for an empty \\u{} and a brace far later", () => {
    expect(cookedToRaw("\\u{}x")(1)).toBe(4); // x
    expect(cookedToRaw("\\u{}x")(2)).toBe(5); // end
    const far = cookedToRaw("\\u{41 then }z");
    expect(far(1)).toBe(12); // z, after the whole braced run
    expect(far(2)).toBe(13);
  });
});

describe("check", () => {
  const codes = (found: readonly { code: string }[]) =>
    found.map((item) => item.code);

  it("reports the name-free findings with nothing configured", () => {
    expect(codes(check(claudeCode, ["Use $ARGUMENTS here"]))).toEqual([
      "template-only",
    ]);
    expect(codes(check(claudeCode, ["/clear"]))).toEqual([
      "consumed-by-harness",
    ]);
    expect(codes(check(codex, ["!git status"]))).toEqual([
      "consumed-by-harness",
    ]);
  });

  it("questions no skill or agent until a source lists some", () => {
    expect(check(claudeCode, ['/nope and @"nobody (agent)"'])).toEqual([]);
    expect(check(codex, ["$nope"])).toEqual([]);
    expect(check(codex, ["$review"], { sources: { agent: [] } })).toEqual([]);
  });

  it("still checks what the dialect itself knows", () => {
    expect(codes(check(codex, ["/nope"]))).toEqual([
      "consumed-by-harness",
      "unresolved-reference",
    ]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a cooked chunk with a harness variable.
    const variable = "${NOPE}";
    expect(
      codes(check(claudeCode, [variable], { surface: "template" }))
    ).toEqual(["unresolved-reference"]);
  });

  it("resolves against listed names and flags another dialect's sigil", () => {
    const sources = { agent: ["reviewer"], skill: ["review"] };
    expect(
      check(claudeCode, ['/review-it @"reviewer (agent)"'], {
        sources: { ...sources, skill: ["review-it"] },
      })
    ).toEqual([]);
    const found = check(claudeCode, ["Use $review and /nope"], { sources });
    expect(found.map((item) => [item.code, item.span])).toEqual([
      ["foreign-notation", { end: 11, start: 4 }],
      ["unresolved-reference", { end: 21, start: 16 }],
    ]);
    expect(found[0]?.message).toContain('reads a skill as "/review"');
  });

  it("accepts a source object", () => {
    const source = {
      covers: (kind: string) => kind === "skill",
      has: (_kind: string, name: string) => name === "review",
    };
    expect(check(codex, ["$review"], { sources: source })).toEqual([]);
    expect(codes(check(codex, ["$nope"], { sources: source }))).toEqual([
      "unresolved-reference",
    ]);
  });

  it("never reports a hole", () => {
    expect(
      check(claudeCode, ["Review @", " with /", ""], { sources: { skill: [] } })
    ).toEqual([]);
  });

  it("reads a template surface", () => {
    expect(check(claudeCode, ["$ARGUMENTS"], { surface: "template" })).toEqual(
      []
    );
  });

  it("reads a custom dialect against every stock one", () => {
    const custom = new Dialect({
      id: "custom",
      label: "Custom",
      notations: [
        notation.invocation({ id: "custom/skill", kind: "skill", sigil: "#" }),
      ],
    });
    const sources = { skill: ["review"] };
    expect(check(custom, ["#review"], { sources })).toEqual([]);
    const message = (chunks: string[]) =>
      check(custom, chunks, { sources }).map((item) => item.message);
    expect(message(["Use $review"])).toEqual([
      '"$review" is Codex notation; Custom reads a skill as "#review".',
    ]);
    expect(message(["/skill:review"])).toEqual([
      '"/skill:review" is Pi notation; Custom reads a skill as "#review".',
    ]);
  });

  it("orders findings by position", () => {
    const found = check(claudeCode, ["/clear $ARGUMENTS"]);
    expect(found.map((item) => item.span.start)).toEqual([0, 7]);
  });
});
