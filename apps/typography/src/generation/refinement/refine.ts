/**
 * Refine: applies the corrections an evaluation marked as automatic. Whatever
 * is left is for a person in the studio, or for another generation.
 */
import {
  type Contour,
  type Outline,
  outlineBounds,
  transformOutline,
} from "~/typeface/outline";
import type { GlyphDraft } from "../draft";
import type { Correction, Evaluation } from "../evaluation/evaluation";
import { cleanOutline, debrisArea } from "../normalise/clean";
import type { HeightZone } from "../normalise/height-model";
import { spaceGlyph } from "../normalise/spacing";
import type { StyleReference } from "../style/reference";
import { orientByNesting } from "../vector/direction";

export interface RefinementContext {
  readonly style: StyleReference;
  readonly zone?: HeightZone;
}

export interface Refinement {
  /** The corrections that were applied, in order. */
  readonly applied: readonly Correction[];
  readonly draft: GlyphDraft;
}

/** Corrections run in this order: shape first, then size, then the space around it. */
const ORDER: readonly Correction[] = [
  "remove-debris",
  "close-contours",
  "fix-direction",
  "refit-heights",
  "respace",
];

const closeContour = (contour: Contour): Contour => {
  const last = contour.segments.at(-1)?.to ?? contour.start;
  return last.x === contour.start.x && last.y === contour.start.y
    ? contour
    : {
        segments: [...contour.segments, { kind: "line", to: contour.start }],
        start: contour.start,
      };
};

/**
 * Scales and moves a glyph so its ink stands between the zone's lines. With
 * one line known it only moves. The advance scales with the outline.
 */
const refit = (draft: GlyphDraft, zone: HeightZone | undefined): GlyphDraft => {
  const bounds = outlineBounds(draft.outline);
  if (!(bounds && zone) || bounds.yMax <= bounds.yMin) {
    return draft;
  }
  const { bottom, top } = zone;
  const scale =
    top !== undefined && bottom !== undefined
      ? (top - bottom) / (bounds.yMax - bounds.yMin)
      : 1;
  const lift =
    bottom === undefined
      ? (top ?? bounds.yMax) - bounds.yMax * scale
      : bottom - bounds.yMin * scale;
  return {
    ...draft,
    advance: Math.round(draft.advance * scale),
    outline: transformOutline(draft.outline, {
      dx: 0,
      dy: lift,
      xx: scale,
      xy: 0,
      yx: 0,
      yy: scale,
    }),
  };
};

const tidy = (outline: Outline): Outline =>
  cleanOutline(outline, { minimumArea: 0 }).outline;

const apply = (
  draft: GlyphDraft,
  correction: Correction,
  { style, zone }: RefinementContext
): GlyphDraft => {
  switch (correction) {
    case "remove-debris":
      return {
        ...draft,
        outline: cleanOutline(draft.outline, {
          minimumArea: debrisArea(style.stems.vertical, style.unitsPerEm),
        }).outline,
      };
    case "close-contours":
      return {
        ...draft,
        outline: { contours: draft.outline.contours.map(closeContour) },
      };
    case "fix-direction":
      return { ...draft, outline: orientByNesting(draft.outline) };
    case "refit-heights": {
      const fitted = refit(draft, zone);
      return { ...fitted, outline: tidy(fitted.outline) };
    }
    default: {
      const spaced = spaceGlyph(draft.outline, style);
      return {
        ...draft,
        advance: spaced.advance,
        outline: tidy(spaced.outline),
      };
    }
  }
};

/** Applies every automatic correction the evaluation asks for. */
export const refineGlyph = (
  draft: GlyphDraft,
  evaluation: Evaluation,
  context: RefinementContext
): Refinement => {
  const wanted = new Set(
    evaluation.defects.flatMap((defect) => defect.correction ?? [])
  );
  const applied = ORDER.filter((correction) => wanted.has(correction));
  return {
    applied,
    draft: applied.reduce(
      (current, correction) => apply(current, correction, context),
      draft
    ),
  };
};
