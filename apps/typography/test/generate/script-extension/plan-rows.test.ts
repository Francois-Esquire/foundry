import { describe, expect, it } from "vitest";
import {
  codePointsOf,
  drawnInWords,
  KIND_NAMES,
  ruleInWords,
} from "~/generate/script-extension/plan-rows";
import { DEVANAGARI_SUBSET as plan } from "~/generation/script-extension/devanagari-subset";

const planned = (name: string) => {
  const glyph = plan.glyphs.find((candidate) => candidate.name === name);
  if (!glyph) {
    throw new Error(`${name} is not in the plan.`);
  }
  return glyph;
};

const ENDS_AS_A_SENTENCE = /\.$/;

const rule = (name: string) => ruleInWords(planned(name), plan.layout);

describe("a planned glyph in words", () => {
  it("names the feature and the glyphs a conjunct replaces", () => {
    expect(rule("kssa-deva")).toBe(
      "No character maps to it. The akhn feature puts it in place of ka-deva, virama-deva, ssa-deva when they follow one another."
    );
  });

  it("names the letter and the joiner a half form replaces", () => {
    expect(rule("sa-deva.half")).toBe(
      "No character maps to it. The half feature puts it in place of sa-deva followed by virama-deva."
    );
  });

  it("says a mark has no advance and which feature attaches it", () => {
    expect(rule("eMatra-deva")).toContain("abvm");
    expect(rule("virama-deva")).toContain("blwm");
    expect(rule("anusvara-deva")).toContain("no advance");
  });

  it("tells a vowel sign set before its base from one set after", () => {
    expect(rule("iMatra-deva")).toContain("before the base");
    expect(rule("aaMatra-deva")).toContain("after its base");
  });

  it("has a name and a sentence for every kind in the plan", () => {
    for (const glyph of plan.glyphs) {
      expect(KIND_NAMES[glyph.rule.kind]).toBeTruthy();
      expect(ruleInWords(glyph, plan.layout)).toMatch(ENDS_AS_A_SENTENCE);
    }
  });

  it("says whether a glyph is drawn whole or separated from a syllable", () => {
    expect(drawnInWords(planned("ka-deva"))).toBe(
      "Drawn whole in its own sheet cell."
    );
    expect(drawnInWords(planned("iMatra-deva"))).toBe(
      "Separated from the syllable U+0915 U+093F, drawn on ka-deva."
    );
  });

  it("spells a text as its code points", () => {
    expect(codePointsOf("क्ष")).toEqual([0x09_15, 0x09_4d, 0x09_37]);
  });
});
