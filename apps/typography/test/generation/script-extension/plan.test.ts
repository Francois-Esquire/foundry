import { describe, expect, it } from "vitest";
import { DEVANAGARI_SUBSET as plan } from "~/generation/script-extension/devanagari-subset";
import {
  type HeadlineLines,
  headlineHeightModel,
} from "~/generation/script-extension/headline-lines";
import {
  nameCollisions,
  type PlannedGlyph,
  plannedSyllables,
  syllableKey,
  targetsForCells,
} from "~/generation/script-extension/plan";

/** The glyphs a rule names, which the plan has to hold too. */
const rulePartsOf = ({ rule }: PlannedGlyph): readonly string[] => {
  if (rule.kind === "conjunct") {
    return rule.parts;
  }
  return rule.kind === "half-form" ? [rule.of, rule.joiner] : [];
};

const LINES: HeadlineLines = {
  bodyTop: 1000,
  headlineThickness: 150,
  headlineTop: 1150,
  rule: "",
};

describe("the Devanagari subset plan", () => {
  const names = new Set(plan.glyphs.map((glyph) => glyph.name));

  it("holds the fifteen characters and the three forms with no character", () => {
    const characters = plan.glyphs.flatMap((glyph) => glyph.characters);
    expect(String.fromCodePoint(...characters)).toBe("अकतनमरलसषािीें्");
    expect(
      plan.glyphs
        .filter((glyph) => glyph.characters.length === 0)
        .map((glyph) => [glyph.name, glyph.rule.kind])
    ).toEqual([
      ["kssa-deva", "conjunct"],
      ["sa-deva.half", "half-form"],
      ["na-deva.half", "half-form"],
    ]);
  });

  it("names every glyph once, and only glyphs it has in rules and words", () => {
    expect(names.size).toBe(plan.glyphs.length);
    for (const glyph of plan.glyphs) {
      const needs = rulePartsOf(glyph);
      for (const name of [...needs, glyph.shownIn?.base ?? glyph.name]) {
        expect(names).toContain(name);
      }
    }
    for (const word of plan.words) {
      for (const name of word.glyphs) {
        expect(names).toContain(name);
      }
    }
  });

  it("lists the nine test words", () => {
    expect(plan.words.map((word) => word.text)).toEqual([
      "नमस्ते",
      "सितार",
      "कमल",
      "नाम",
      "तारा",
      "रस",
      "मन",
      "संत",
      "क्ष",
    ]);
  });

  it("reports the planned names a source font already uses", () => {
    expect(nameCollisions(plan, new Set(["A", "ka-deva", "space"]))).toEqual([
      "ka-deva",
    ]);
  });
});

describe("the targets for a sheet", () => {
  it("asks for a letter and a conjunct whole, by the cell that shows them", () => {
    const targets = targetsForCells(plan, ["क", "क्ष", "ही"]);
    expect(targets.map((target) => target.key)).toEqual([
      "ka-deva",
      "kssa-deva",
    ]);
    expect(targets[0]?.characters).toEqual([0x09_15]);
    expect(targets[1]?.characters).toEqual([]);
  });

  it("asks for a syllable and the glyph separated from it", () => {
    const targets = targetsForCells(plan, ["का", "स्त"]);
    expect(targets.map((target) => target.key)).toEqual([
      syllableKey("का"),
      syllableKey("स्त"),
      "aaMatra-deva",
      "sa-deva.half",
    ]);
    expect(targets.at(2)?.needs).toEqual([syllableKey("का")]);
  });

  it("separates all eight signs and half forms from eight syllables", () => {
    expect(plannedSyllables(plan)).toEqual([
      "का",
      "कि",
      "की",
      "के",
      "कं",
      "क्",
      "स्त",
      "न्त",
    ]);
  });
});

describe("the headline height model", () => {
  const model = headlineHeightModel(plan, LINES);
  const zoneOf = (key: string) =>
    model({ characters: [], key, name: key, needs: [], text: "" });

  it("stands a letter between the baseline and the top of the headline", () => {
    expect(zoneOf("ka-deva")).toMatchObject({ bottom: 0, top: 1150 });
  });

  it("frees the foot of a conjunct and of a half form", () => {
    expect(zoneOf("kssa-deva")).toMatchObject({ bottom: undefined, top: 1150 });
    expect(zoneOf("na-deva.half")).toMatchObject({
      bottom: undefined,
      top: 1150,
    });
  });

  it("gives a mark no line at all", () => {
    expect(zoneOf("anusvara-deva")).toMatchObject({
      bottom: undefined,
      top: undefined,
    });
  });

  it("fits a syllable by the lines its parts leave alone", () => {
    // A vowel sign may carry a hook over the headline, so its syllable's top is free.
    expect(zoneOf(syllableKey("कि"))).toMatchObject({
      bottom: 0,
      top: undefined,
    });
    expect(zoneOf(syllableKey("क्"))).toMatchObject({
      bottom: undefined,
      top: 1150,
    });
    expect(zoneOf(syllableKey("स्त"))).toMatchObject({ bottom: 0, top: 1150 });
  });

  it("gives a cell the plan does not want no line", () => {
    expect(zoneOf("unplanned:11")).toEqual({ name: "unplanned" });
  });
});
