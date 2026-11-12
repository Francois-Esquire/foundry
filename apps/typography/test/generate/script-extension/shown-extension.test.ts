import { describe, expect, it } from "vitest";
import { shownExtension } from "~/generate/script-extension/shown-extension";
import type { ScriptExtensionPlan } from "~/generation/script-extension/plan";
import type { AddedGlyph } from "~/typeface/changes";

const plan: ScriptExtensionPlan = {
  glyphs: ["first", "second"].map((name) => ({
    characters: [],
    name,
    rule: { kind: "base" },
    text: name,
  })),
  iso15924: "Deva",
  layout: {
    features: {
      conjunct: "cjct",
      halfForm: "half",
      markAbove: "abvm",
      markBelow: "blwm",
    },
    tags: ["dev2"],
  },
  script: "Devanagari",
  words: [],
};

const glyph = (name: string): AddedGlyph => ({
  advance: 400,
  characters: [65],
  key: `key:${name}`,
  name,
  outline: { contours: [] },
  provenance: { origin: "manual" },
});

describe("showing project glyphs", () => {
  it("pairs project glyph data with entries in plan order", () => {
    const first = glyph("first");
    const second = glyph("second");
    expect(shownExtension([second, first], plan)).toEqual({
      glyphs: [
        { ...first, planned: plan.glyphs[0] },
        { ...second, planned: plan.glyphs[1] },
      ],
      missing: [],
      plan,
    });
  });

  it("lists a planned glyph the run lacks", () => {
    expect(shownExtension([glyph("second")], plan).missing).toEqual([
      plan.glyphs[0],
    ]);
  });

  it("leaves out a glyph the plan does not name", () => {
    expect(shownExtension([glyph("other")], plan)).toEqual({
      glyphs: [],
      missing: plan.glyphs,
      plan,
    });
  });
});
