/**
 * Plan: which glyphs a request needs, in an order that builds parts before
 * the glyphs made from them.
 */
import { sourceGlyph } from "~/typeface/changes";
import type { OpenFace } from "~/typeface/reading";
import { decompose, dotlessForm, markAttachment, markForms } from "./marks";
import {
  characterLabel,
  type GlyphTarget,
  glyphNameFor,
  type Recipe,
  targetKeyFor,
} from "./target";

export interface GenerationPlan {
  /** Requested characters the face already has. Nothing is generated for them. */
  readonly present: readonly number[];
  /** Parts first, then the glyphs that need them. */
  readonly targets: readonly GlyphTarget[];
}

const DEFAULT_OBLIQUE_ANGLE = 12;

const has = (face: OpenFace, character: number) =>
  face.glyphForCharacter(character) !== undefined;

/** The base a composite is built on: the dotless form under a mark above, when the face has one. */
const compositeBase = (
  face: OpenFace,
  base: number,
  marks: readonly number[]
): number => {
  const dotless = dotlessForm(base);
  const marked = marks.some((mark) => markAttachment(mark) === "above");
  return dotless !== undefined && marked && has(face, dotless) ? dotless : base;
};

const plainTarget = (character: number): GlyphTarget => ({
  characters: [character],
  key: targetKeyFor(character),
  name: glyphNameFor(character),
  needs: [],
  text: String.fromCodePoint(character),
});

const characterTargets = (face: OpenFace, character: number): GlyphTarget[] => {
  const parts = decompose(character);
  if (!parts) {
    return [plainTarget(character)];
  }
  const base = compositeBase(face, parts.base, parts.marks);
  const missingMarks = parts.marks.filter(
    (mark) => !markForms(mark).some((form) => has(face, form))
  );
  const missing = [...(has(face, base) ? [] : [base]), ...missingMarks];
  const recipe: Recipe = { base, kind: "composite", marks: parts.marks };
  return [
    ...missing.map(plainTarget),
    { ...plainTarget(character), needs: missing.map(targetKeyFor), recipe },
  ];
};

/**
 * Plans the characters a face lacks. A character that decomposes gets a
 * recipe from its base and marks, and any part the face lacks is planned
 * before it.
 */
export const planCharacters = (
  face: OpenFace,
  characters: readonly number[]
): GenerationPlan => {
  const present: number[] = [];
  const targets = new Map<string, GlyphTarget>();
  for (const character of new Set(characters)) {
    if (has(face, character)) {
      present.push(character);
      continue;
    }
    for (const target of characterTargets(face, character)) {
      const planned = targets.get(target.key);
      if (!planned || (target.recipe && !planned.recipe)) {
        targets.delete(target.key);
        targets.set(target.key, target);
      }
    }
  }
  const ordered = [...targets.values()];
  return {
    present,
    targets: [
      ...ordered.filter((target) => target.needs.length === 0),
      ...ordered.filter((target) => target.needs.length > 0),
    ],
  };
};

/** Plans slanted redrawings of glyphs the face has, by shearing each one. */
export const planOblique = (
  face: OpenFace,
  characters: readonly number[],
  angle = DEFAULT_OBLIQUE_ANGLE
): GenerationPlan => {
  const targets = new Map<string, GlyphTarget>();
  for (const character of new Set(characters)) {
    const glyphId = face.glyphForCharacter(character);
    if (glyphId !== undefined) {
      const key = `oblique:${glyphId}`;
      targets.set(key, {
        characters: face.charactersForGlyph(glyphId),
        key,
        name: `${glyphNameFor(character)}.oblique`,
        needs: [],
        recipe: { angle, glyphId, kind: "oblique" },
        replaces: sourceGlyph(glyphId),
        text: String.fromCodePoint(character),
      });
    }
  }
  return { present: [], targets: [...targets.values()] };
};

/**
 * Plans small capitals for lowercase letters: unmapped glyphs, reached
 * through a layout feature, each scaled from the letter's capital.
 */
export const planSmallCapitals = (
  face: OpenFace,
  characters: readonly number[]
): GenerationPlan => {
  const targets: GlyphTarget[] = [];
  for (const character of new Set(characters)) {
    const letter = String.fromCodePoint(character);
    const capital = letter.toUpperCase().codePointAt(0);
    const single = [...letter.toUpperCase()].length === 1;
    if (capital !== undefined && capital !== character && single) {
      targets.push({
        characters: [],
        key: `small-capital:${targetKeyFor(character)}`,
        name: `${glyphNameFor(character)}.sc`,
        needs: has(face, capital) ? [] : [targetKeyFor(capital)],
        recipe: { capital, kind: "small-capital" },
        text: letter,
      });
    }
  }
  return { present: [], targets };
};

/**
 * A target for a form no single character maps to, such as a conjunct or a
 * ligature, named by the text that shapes to it.
 */
export const planForm = (text: string, name: string): GlyphTarget => ({
  characters: [],
  key: `form:${[...text].map((part) => characterLabel(part.codePointAt(0) ?? 0)).join("+")}`,
  name,
  needs: [],
  text,
});
