import { describe, expect, it } from "vitest";

import {
  assemble,
  claudeCode,
  cookedToRaw,
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
});
