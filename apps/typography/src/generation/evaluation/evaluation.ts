/** The shape of an evaluation: measured checks, defects, scores and one verdict. */
import type { Verdict as CandidateVerdict } from "~/typeface/project";

/** A correction refinement can apply without a person. */
export type Correction =
  | "close-contours"
  | "fix-direction"
  | "refit-heights"
  | "remove-debris"
  | "respace";

type DefectKind =
  | "debris"
  | "direction"
  | "empty"
  | "heights"
  | "ink-density"
  | "not-finite"
  | "open-contour"
  | "outside-metrics"
  | "point-count"
  | "shape"
  | "spacing"
  | "stem-thickness";

export interface Defect {
  /** The correction that fixes it. Absent when a person or a new generation has to. */
  readonly correction?: Correction;
  readonly detail: string;
  readonly kind: DefectKind;
}

export const isCorrectable = (defect: Defect) =>
  defect.correction !== undefined;

/** One measured comparison against the style reference. */
export interface StyleCheck {
  readonly expected: number;
  readonly measured: number;
  readonly name: string;
  readonly pass: boolean;
  /** How far `measured` may be from `expected`, in the same unit. */
  readonly tolerance: number;
}

/** The verdict a candidate carries into the project, which declares it. */
export type Verdict = CandidateVerdict;

/**
 * What an evaluation measured, without its verdict. A candidate carries its
 * final verdict itself, so what is kept beside a candidate holds no second one.
 */
export type Measured = Omit<Evaluation, "verdict">;

export interface Evaluation {
  readonly defects: readonly Defect[];
  readonly key: string;
  /** The rule or route that made the glyph. */
  readonly madeBy: string;
  readonly scores: {
    /** Share of geometry checks passed. */
    readonly geometry: number;
    /** Intersection over union with the holdout after aligning the two shapes. */
    readonly shape?: number;
    /** The same with both shapes left where they are, so misplacement counts. */
    readonly shapeInPlace?: number;
    /** Share of style checks passed. */
    readonly style: number;
  };
  readonly styleChecks: readonly StyleCheck[];
  readonly verdict: Verdict;
  /** What the route that made the glyph is known to get wrong. */
  readonly weaknesses: readonly string[];
}
