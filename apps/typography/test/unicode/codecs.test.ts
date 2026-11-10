import { describe, expect, it } from "vitest";
import { decodeCodePoints, encodeCodePoints } from "~/unicode/code-point-set";
import { ExemplarSyntaxError, expandExemplarSet } from "~/unicode/exemplar-set";
import { decodeNames, encodeNames } from "~/unicode/name-table";

const codePointsOf = (text: string) =>
  [...text].map((symbol) => symbol.codePointAt(0) ?? 0);

describe("code point sets", () => {
  it("writes runs as a gap and an extent in base 36", () => {
    expect(encodeCodePoints(codePointsOf("abcdefghijklmnopqrstuvwxyz"))).toBe(
      "2p.p"
    );
    expect(encodeCodePoints([0, 2, 3, 4, 100])).toBe("0,1.2,2n");
  });

  it("round-trips unordered input with duplicates", () => {
    const decoded = decodeCodePoints(
      encodeCodePoints([0x1_f6_00, 0x41, 0x42, 0x41, 0x9_15, 0x10_ff_ff])
    );
    expect([...decoded]).toEqual([0x41, 0x42, 0x9_15, 0x1_f6_00, 0x10_ff_ff]);
  });

  it("round-trips the empty set", () => {
    expect(encodeCodePoints([])).toBe("");
    expect(decodeCodePoints("")).toHaveLength(0);
  });
});

describe("name tables", () => {
  it("round-trips names, sharing prefixes and skipping gaps", () => {
    const entries: [number, string][] = [
      [0x41, "LATIN CAPITAL LETTER A"],
      [0x42, "LATIN CAPITAL LETTER B"],
      [0x9_15, "DEVANAGARI LETTER KA"],
      [0x9_16, "DEVANAGARI LETTER KHA"],
      [0x1_f6_00, "GRINNING FACE"],
    ];
    const encoded = encodeNames(entries);
    expect(encoded.startsWith("1u,0LATIN CAPITAL LETTER A;,lB;")).toBe(true);
    expect([...decodeNames(encoded)]).toEqual(entries);
  });

  it("decodes an empty table", () => {
    expect(decodeNames("").size).toBe(0);
  });
});

describe("exemplar sets", () => {
  it("expands single characters and ignores spacing", () => {
    expect(expandExemplarSet("[a b c]")).toEqual(codePointsOf("abc"));
    expect(expandExemplarSet("[]")).toEqual([]);
  });

  it("expands ranges", () => {
    expect(expandExemplarSet("[a-e x]")).toEqual(codePointsOf("abcdex"));
  });

  it("reads escapes: \\u, \\U, \\x and escaped syntax characters", () => {
    expect(expandExemplarSet("[\\u200C\\u200D ॄ]")).toEqual([
      0x9_44, 0x20_0c, 0x20_0d,
    ]);
    expect(expandExemplarSet("[\\U0001F600 \\x41 \\x{1F601}]")).toEqual([
      0x41, 0x1_f6_00, 0x1_f6_01,
    ]);
    expect(expandExemplarSet("[\\- \\: \\[ \\] \\& \\\\]")).toEqual(
      codePointsOf("&-:[\\]")
    );
  });

  it("treats an escaped dash as a character, not a range", () => {
    expect(expandExemplarSet("[a \\- z]")).toEqual(codePointsOf("-az"));
  });

  it("gives every code point of a multi-character string", () => {
    expect(expandExemplarSet("[c h {ch} {dž}]")).toEqual(codePointsOf("cdhž"));
    // Russian stressed vowels: a letter and a combining acute.
    expect(expandExemplarSet("[{а́}]")).toEqual([0x3_01, 0x4_30]);
    // A Devanagari conjunct: ka, virama, ssa.
    expect(expandExemplarSet("[{क्ष}]")).toEqual([0x9_15, 0x9_37, 0x9_4d]);
  });

  it("keeps characters outside the basic plane whole", () => {
    expect(expandExemplarSet("[𞤀 𞤁]")).toEqual([0x1_e9_00, 0x1_e9_01]);
  });

  it("refuses syntax it does not expand", () => {
    expect(() => expandExemplarSet("a b c")).toThrow(ExemplarSyntaxError);
    expect(() => expandExemplarSet("[\\p{L}]")).toThrow(ExemplarSyntaxError);
    expect(() => expandExemplarSet("[a [b c]]")).toThrow(ExemplarSyntaxError);
    expect(() => expandExemplarSet("[{ab]")).toThrow(ExemplarSyntaxError);
    expect(() => expandExemplarSet("[\\uZZZZ]")).toThrow(ExemplarSyntaxError);
  });
});
