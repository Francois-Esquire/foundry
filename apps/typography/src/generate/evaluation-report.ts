/** An evaluation in the words and figures the candidate board prints. */
import type {
  Correction,
  Defect,
  Evaluation,
  Verdict,
} from "~/generation/evaluation/evaluation";

export const VERDICT_NAMES: Readonly<Record<Verdict, string>> = {
  fail: "Failed",
  pass: "Passed",
  review: "Needs review",
};

const CORRECTION_NAMES: Readonly<Record<Correction, string>> = {
  "close-contours": "contours closed",
  "fix-direction": "contour direction fixed",
  "refit-heights": "heights refitted",
  "remove-debris": "debris removed",
  respace: "respaced",
};

export interface DefectLine {
  readonly detail: string;
  /** How refinement fixed it, for a corrected defect. */
  readonly fix?: string;
  readonly state: "corrected" | "remaining";
}

/**
 * Every defect found in a glyph, saying which were corrected. A defect of
 * the first evaluation counts as corrected when its correction was applied
 * and the final evaluation finds nothing of that kind any more. What the
 * final evaluation still finds remains for a person.
 */
export const defectLines = (
  first: Evaluation | undefined,
  final: Evaluation,
  applied: readonly Correction[]
): DefectLine[] => {
  const remainingKinds = new Set(final.defects.map((defect) => defect.kind));
  const corrected = (first?.defects ?? []).flatMap(
    (defect: Defect): DefectLine[] =>
      defect.correction !== undefined &&
      applied.includes(defect.correction) &&
      !remainingKinds.has(defect.kind)
        ? [
            {
              detail: defect.detail,
              fix: CORRECTION_NAMES[defect.correction],
              state: "corrected",
            },
          ]
        : []
  );
  return [
    ...corrected,
    ...final.defects.map(
      (defect): DefectLine => ({ detail: defect.detail, state: "remaining" })
    ),
  ];
};

/** A score between 0 and 1, to two places. */
export const formatScore = (score: number) => score.toFixed(2);

/**
 * A value of a style check, in the unit of the check: whole font units for
 * sizes and positions, two places for a ratio such as ink density. The
 * allowed difference tells the two apart, since it is in the same unit.
 */
export const formatMeasure = (value: number, tolerance: number) =>
  tolerance >= 1 ? String(Math.round(value) || 0) : value.toFixed(2);

/** True when the run compared this glyph with the face's own. */
export const hasAgreement = (
  evaluation: Evaluation
): evaluation is Evaluation & {
  readonly scores: { readonly shape: number };
} => evaluation.scores.shape !== undefined;
