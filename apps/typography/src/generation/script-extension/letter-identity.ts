/**
 * Letter identity: is each generated letter the letter it was asked to be.
 * Each one is compared with every letter of the subset in a reference face,
 * and should agree most with its own. This says nothing about style: the
 * reference is another design, used only to tell letters apart.
 */
import { type Outline, transformOutline } from "~/typeface/outline";
import type { OpenFace } from "~/typeface/reading";
import { shapeAgreement } from "../evaluation/agreement";
import { snapToHeadline } from "./glyph-lines";
import type { HeadlineLines } from "./headline-lines";
import type { PlannedGlyph, ScriptExtensionPlan } from "./plan";

export interface LetterIdentity {
  /** The reference letter the generated one agrees with most. */
  readonly closest: string;
  /** Agreement with the closest reference letter, 0 to 1. */
  readonly closestScore: number;
  readonly name: string;
  /** Agreement with its own reference letter, 0 to 1. */
  readonly ownScore: number;
  readonly pass: boolean;
}

/** The glyphs compared: letters and conjuncts, which a reference face draws as one glyph. */
export const comparedLetters = (plan: ScriptExtensionPlan): PlannedGlyph[] =>
  plan.glyphs.filter(
    (glyph) => glyph.rule.kind === "base" || glyph.rule.kind === "conjunct"
  );

/** The reference face's glyph for a letter, scaled until its headline sits on the model's. */
const referenceLetter = (
  reference: OpenFace,
  glyph: PlannedGlyph,
  plan: ScriptExtensionPlan,
  lines: HeadlineLines,
  unitsPerEm: number
): Outline | undefined => {
  const shaped = reference.shape(glyph.text, { script: plan.iso15924 }).glyphs;
  const [only] = shaped;
  if (shaped.length !== 1 || !only || only.glyphId === 0) {
    return;
  }
  const scale = unitsPerEm / reference.description.metrics.unitsPerEm;
  return snapToHeadline(
    transformOutline(reference.glyph(only.glyphId).outline, {
      dx: 0,
      dy: 0,
      xx: scale,
      xy: 0,
      yx: 0,
      yy: scale,
    }),
    lines
  );
};

/**
 * Compares each generated letter with every reference letter. A letter the
 * reference face has no single glyph for is left out, on both sides.
 */
export const checkLetterIdentity = (
  plan: ScriptExtensionPlan,
  lines: HeadlineLines,
  generated: ReadonlyMap<string, Outline>,
  reference: OpenFace,
  unitsPerEm: number
): LetterIdentity[] => {
  const references = comparedLetters(plan).flatMap((glyph) => {
    const outline = referenceLetter(reference, glyph, plan, lines, unitsPerEm);
    return outline ? [{ name: glyph.name, outline }] : [];
  });
  return references.flatMap(({ name }) => {
    const own = generated.get(name);
    if (!own) {
      return [];
    }
    const scores = references.map((other) => ({
      name: other.name,
      score: shapeAgreement(own, other.outline, unitsPerEm).aligned,
    }));
    const closest = scores.reduce((best, score) =>
      score.score > best.score ? score : best
    );
    const ownScore = scores.find((score) => score.name === name)?.score ?? 0;
    return [
      {
        closest: closest.name,
        closestScore: closest.score,
        name,
        ownScore,
        pass: closest.name === name,
      },
    ];
  });
};
