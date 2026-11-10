import { describe, expect, it } from "vitest";
import {
  plannedCharacters,
  scopeOf,
  scopeStatement,
} from "~/generate/script-extension/scope";
import { DEVANAGARI_SUBSET as plan } from "~/generation/script-extension/devanagari-subset";

describe("the scope of the Devanagari subset", () => {
  it("counts characters, forms with no character and test words", () => {
    expect(scopeOf(plan)).toEqual({
      characters: 15,
      forms: 3,
      glyphs: 18,
      script: "Devanagari",
      words: 9,
    });
    expect(plannedCharacters(plan)).toHaveLength(15);
  });

  it("states a defined subset and never support for the script", () => {
    expect(scopeStatement(plan)).toBe(
      "This is a defined subset: 15 characters, 3 forms with no character of their own, and 9 test words. It is not support for Devanagari."
    );
  });
});
