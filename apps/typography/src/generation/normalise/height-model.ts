/**
 * Height models: which two lines a glyph is expected to stand between. The
 * model is passed in, so a script with its own conventions brings its own
 * lines and nothing downstream assumes Latin ones.
 */
import { decompose, markAttachment } from "../plan/marks";
import type { GlyphTarget } from "../plan/target";
import type { StyleReference } from "../style/reference";

/** The lines a glyph's ink should reach, in font units. A missing end is free. */
export interface HeightZone {
  readonly bottom?: number;
  /** What kind of glyph the zone is for, for reports. */
  readonly name: string;
  readonly top?: number;
}

export type HeightModel = (target: GlyphTarget) => HeightZone;

const UPPERCASE = /\p{Lu}/u;
const LOWERCASE = /\p{Ll}/u;
const DIGIT = /\p{Nd}/u;
const ASCENDING = new Set([..."bdfhklþßðŀ"]);
const DESCENDING = new Set([..."gjpqyþçŋ"]);
/** Lowercase letters whose top is a dot or a stroke that follows no line. */
const FREE_TOP = new Set([..."ijt"]);
/** Capitals with a tail or hook that many faces take below the baseline. */
const FREE_FOOT = new Set([..."QJ"]);

const firstCharacter = (target: GlyphTarget): number =>
  target.characters[0] ?? target.text.codePointAt(0) ?? 0;

const latinBase = (
  letter: string,
  { ascender, capHeight, descender, xHeight }: StyleReference["metrics"]
): HeightZone => {
  if (UPPERCASE.test(letter)) {
    return {
      bottom: FREE_FOOT.has(letter) ? undefined : 0,
      name: "capital",
      top: capHeight,
    };
  }
  if (DIGIT.test(letter)) {
    return { bottom: 0, name: "figure", top: capHeight };
  }
  if (!LOWERCASE.test(letter)) {
    return { name: "punctuation" };
  }
  const bottom = DESCENDING.has(letter) ? descender : 0;
  if (FREE_TOP.has(letter)) {
    return { bottom, name: "lowercase" };
  }
  if (ASCENDING.has(letter)) {
    return { bottom, name: "lowercase with ascender", top: ascender };
  }
  return {
    bottom,
    name: bottom < 0 ? "lowercase with descender" : "lowercase",
    top: xHeight,
  };
};

/**
 * The Latin model: capitals and figures to the cap height, lowercase to the
 * x-height, ascender or descender. A mark above frees the top and a mark
 * below frees the bottom. A small capital stands on the x-height.
 * Punctuation is left to the scale of its sheet.
 */
export const latinHeightModel =
  (style: StyleReference): HeightModel =>
  (target) => {
    if (target.recipe?.kind === "small-capital") {
      return { bottom: 0, name: "small capital", top: style.metrics.xHeight };
    }
    const character = firstCharacter(target);
    const parts = decompose(character);
    const zone = latinBase(
      String.fromCodePoint(parts?.base ?? character),
      style.metrics
    );
    const attachments = (parts?.marks ?? []).map(markAttachment);
    return {
      bottom: attachments.some((attachment) => attachment !== "above")
        ? undefined
        : zone.bottom,
      name: parts ? `${zone.name} with a mark` : zone.name,
      top: attachments.includes("above") ? undefined : zone.top,
    };
  };

/** A model for a script whose letters all stand between the same two lines. */
export const uniformHeightModel =
  (zone: HeightZone): HeightModel =>
  () =>
    zone;
