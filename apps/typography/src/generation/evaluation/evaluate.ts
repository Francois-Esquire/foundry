/** Validate: judges one glyph draft on geometry, style and, with a holdout, shape. */
import type { GlyphShape } from "~/typeface/reading";
import type { GlyphDraft } from "../draft";
import type { HeightZone } from "../normalise/height-model";
import type { StyleReference } from "../style/reference";
import { shapeAgreement } from "./agreement";
import type { Defect, Evaluation, Verdict } from "./evaluation";
import { checkGeometry } from "./geometry";
import { checkStyle } from "./style-checks";

export interface EvaluationContext {
  /**
   * The face's own glyph for the same character, when the run is a holdout
   * test. The draft is compared with it and never built from it.
   */
  readonly holdout?: GlyphShape;
  readonly style: StyleReference;
  /** The lines the glyph should stand between, from the height model. */
  readonly zone?: HeightZone;
}

/** Below this agreement with a holdout the shape is a different drawing, not a variation. */
const SHAPE_FLOOR = 0.8;
const FATAL = new Set<Defect["kind"]>(["empty", "not-finite"]);

const verdictOf = (defects: readonly Defect[]): Verdict => {
  if (defects.some((defect) => FATAL.has(defect.kind))) {
    return "fail";
  }
  return defects.length > 0 ? "review" : "pass";
};

export const evaluateGlyph = (
  draft: GlyphDraft,
  context: EvaluationContext
): Evaluation => {
  const geometry = checkGeometry(draft.outline, context.style, context.zone);
  const sound = !geometry.defects.some((defect) => FATAL.has(defect.kind));
  const style = sound
    ? checkStyle(draft, context.style, context.zone)
    : { checks: [], defects: [] };
  const agreement =
    sound && context.holdout
      ? shapeAgreement(
          draft.outline,
          context.holdout.outline,
          context.style.unitsPerEm
        )
      : undefined;
  const shapeDefects: Defect[] =
    agreement && agreement.aligned < SHAPE_FLOOR
      ? [
          {
            detail: `The shape agrees with the face's own glyph by ${agreement.aligned.toFixed(2)}, below ${SHAPE_FLOOR}.`,
            kind: "shape",
          },
        ]
      : [];
  const defects = [...geometry.defects, ...style.defects, ...shapeDefects];
  const passedStyle = style.checks.filter((item) => item.pass).length;
  return {
    defects,
    key: draft.key,
    madeBy: draft.madeBy,
    scores: {
      geometry: 1 - Math.min(1, geometry.defects.length / geometry.checks),
      shape: agreement?.aligned,
      shapeInPlace: agreement?.inPlace,
      style: style.checks.length > 0 ? passedStyle / style.checks.length : 0,
    },
    styleChecks: style.checks,
    verdict: verdictOf(defects),
    weaknesses: draft.weaknesses,
  };
};
