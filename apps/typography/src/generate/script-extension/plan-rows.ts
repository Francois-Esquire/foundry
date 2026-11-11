/** A plan's glyphs and test words as the rows the plan tables print. */
import type {
  PlannedGlyph,
  ScriptExtensionPlan,
} from "~/generation/script-extension/plan";
import { formatCodePoint } from "~/lib/code-point";

/** A planned glyph's kind as a short name. */
export const KIND_NAMES: Readonly<
  Record<PlannedGlyph["rule"]["kind"], string>
> = {
  base: "Letter",
  conjunct: "Conjunct",
  "half-form": "Half form",
  "mark-above": "Mark above",
  "mark-below": "Mark below",
  "vowel-sign-after": "Vowel sign after the base",
  "vowel-sign-before": "Vowel sign before the base",
};

/** What layout has to do before text can use the glyph, in a sentence. */
export const ruleInWords = (
  { rule }: PlannedGlyph,
  { features }: ScriptExtensionPlan["layout"]
): string => {
  switch (rule.kind) {
    case "base":
      return "Reached straight from its character. Marks attach to it.";
    case "conjunct":
      return `No character maps to it. The ${features.conjunct} feature puts it in place of ${rule.parts.join(", ")} when they follow one another.`;
    case "half-form":
      return `No character maps to it. The ${features.halfForm} feature puts it in place of ${rule.of} followed by ${rule.joiner}.`;
    case "mark-above":
      return `Reached from its character. It has no advance, and the ${features.markAbove} feature hangs it over the stem of its base.`;
    case "mark-below":
      return `Reached from its character. It has no advance, and the ${features.markBelow} feature hangs it under the stem of its base.`;
    case "vowel-sign-after":
      return "Reached from its character. It has an advance of its own and is set after its base.";
    default:
      return "Reached from its character. It has an advance of its own, and the shaper sets it before the base it follows in the text.";
  }
};

/** The code points of a text, in order. */
export const codePointsOf = (text: string): number[] =>
  [...text].map((character) => character.codePointAt(0) ?? 0);

/**
 * How the glyph gets drawn: alone in a sheet cell, or cut out of a syllable.
 * The syllable is spelled in code points, since the face cannot set it.
 */
export const drawnInWords = ({ shownIn }: PlannedGlyph): string =>
  shownIn
    ? `Separated from the syllable ${codePointsOf(shownIn.syllable).map(formatCodePoint).join(" ")}, drawn on ${shownIn.base}.`
    : "Drawn whole in its own sheet cell.";
