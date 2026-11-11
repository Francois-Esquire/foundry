import { describe, expect, it } from "vitest";
import { countMissing, splitRuns } from "~/unicode/text-runs";

const latinOnly = (codePoint: number) => codePoint >= 0x41 && codePoint <= 0x7a;

describe("splitRuns", () => {
  it("keeps text the face can set in one run, spaces included", () => {
    expect(splitRuns("Type face", latinOnly)).toEqual([
      { kind: "text", start: 0, text: "Type face" },
    ]);
  });

  it("gives each character the face lacks a gap of its own", () => {
    const runs = splitRuns("aकखb", latinOnly);
    expect(runs).toEqual([
      { kind: "text", start: 0, text: "a" },
      { codePoint: 0x9_15, kind: "missing", start: 1 },
      { codePoint: 0x9_16, kind: "missing", start: 2 },
      { kind: "text", start: 3, text: "b" },
    ]);
    expect(countMissing(runs)).toBe(2);
  });

  it("counts a character outside the basic plane as one gap", () => {
    expect(splitRuns("a😀b", latinOnly)).toEqual([
      { kind: "text", start: 0, text: "a" },
      { codePoint: 0x1_f6_00, kind: "missing", start: 1 },
      { kind: "text", start: 3, text: "b" },
    ]);
  });

  it("never marks line ends, joiners or other unseen characters as missing", () => {
    expect(countMissing(splitRuns("a\n‍b ", latinOnly))).toBe(0);
  });

  it("returns nothing for empty text", () => {
    expect(splitRuns("", latinOnly)).toEqual([]);
  });
});

describe("setting text in one font only", () => {
  const has = (codePoint: number) =>
    "abc".includes(String.fromCodePoint(codePoint));

  it("splits out the characters the font lacks and keeps what draws nothing", () => {
    expect(splitRuns("ab xc‍y", has)).toEqual([
      { kind: "text", start: 0, text: "ab " },
      { codePoint: 0x78, kind: "missing", start: 3 },
      { kind: "text", start: 4, text: "c‍" },
      { codePoint: 0x79, kind: "missing", start: 6 },
    ]);
    expect(splitRuns("", has)).toEqual([]);
  });

  it("draws the crossed box for a private use character the font lacks", () => {
    expect(splitRuns("a\u{e000}", has)).toEqual([
      { kind: "text", start: 0, text: "a" },
      { codePoint: 0xe0_00, kind: "missing", start: 1 },
    ]);
  });
});
