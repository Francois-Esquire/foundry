/**
 * The first script extension plan: a small Devanagari subset. Nine letters,
 * four vowel signs, the anusvara and the halant, one conjunct and two half
 * forms. It is a subset for proving the machinery, not Hindi support.
 */
import type { PlannedGlyph, ScriptExtensionPlan } from "./plan";

const letter = (name: string, character: number): PlannedGlyph => ({
  characters: [character],
  name,
  rule: { kind: "base" },
  text: String.fromCodePoint(character),
});

/** A sign a model will not draw alone, shown on क and separated from it. */
const onKa = (
  name: string,
  character: number,
  kind: "mark-above" | "mark-below" | "vowel-sign-after" | "vowel-sign-before"
): PlannedGlyph => ({
  characters: [character],
  name,
  rule: { kind },
  shownIn: {
    base: "ka-deva",
    syllable: `क${String.fromCodePoint(character)}`,
  },
  text: String.fromCodePoint(character),
});

const halfForm = (of: string, letterText: string): PlannedGlyph => ({
  characters: [],
  name: `${of}.half`,
  rule: { joiner: "virama-deva", kind: "half-form", of },
  shownIn: { base: "ta-deva", syllable: `${letterText}्त` },
  text: `${letterText}्`,
});

export const DEVANAGARI_SUBSET: ScriptExtensionPlan = {
  glyphs: [
    letter("a-deva", 0x09_05),
    letter("ka-deva", 0x09_15),
    letter("ta-deva", 0x09_24),
    letter("na-deva", 0x09_28),
    letter("ma-deva", 0x09_2e),
    letter("ra-deva", 0x09_30),
    letter("la-deva", 0x09_32),
    letter("sa-deva", 0x09_38),
    letter("ssa-deva", 0x09_37),
    {
      characters: [],
      name: "kssa-deva",
      rule: {
        kind: "conjunct",
        parts: ["ka-deva", "virama-deva", "ssa-deva"],
      },
      text: "क्ष",
    },
    onKa("aaMatra-deva", 0x09_3e, "vowel-sign-after"),
    onKa("iMatra-deva", 0x09_3f, "vowel-sign-before"),
    onKa("iiMatra-deva", 0x09_40, "vowel-sign-after"),
    onKa("eMatra-deva", 0x09_47, "mark-above"),
    onKa("anusvara-deva", 0x09_02, "mark-above"),
    onKa("virama-deva", 0x09_4d, "mark-below"),
    halfForm("sa-deva", "स"),
    halfForm("na-deva", "न"),
  ],
  iso15924: "Deva",
  layout: {
    features: {
      conjunct: "akhn",
      halfForm: "half",
      markAbove: "abvm",
      markBelow: "blwm",
    },
    tags: ["dev2"],
  },
  script: "Devanagari",
  words: [
    {
      glyphs: ["na-deva", "ma-deva", "sa-deva.half", "ta-deva", "eMatra-deva"],
      text: "नमस्ते",
    },
    {
      glyphs: ["iMatra-deva", "sa-deva", "ta-deva", "aaMatra-deva", "ra-deva"],
      text: "सितार",
    },
    { glyphs: ["ka-deva", "ma-deva", "la-deva"], text: "कमल" },
    { glyphs: ["na-deva", "aaMatra-deva", "ma-deva"], text: "नाम" },
    {
      glyphs: ["ta-deva", "aaMatra-deva", "ra-deva", "aaMatra-deva"],
      text: "तारा",
    },
    { glyphs: ["ra-deva", "sa-deva"], text: "रस" },
    { glyphs: ["ma-deva", "na-deva"], text: "मन" },
    { glyphs: ["sa-deva", "anusvara-deva", "ta-deva"], text: "संत" },
    { glyphs: ["kssa-deva"], text: "क्ष" },
  ],
};
