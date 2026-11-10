/**
 * Reconstruction from evidence to observed candidates, in one call: view the
 * region upright, isolate the lettering, read it, trace it. Each step is a
 * plain function that a screen can also call alone.
 */
import type { Evidence } from "./evidence/evidence";
import {
  type RegionView,
  type ViewOptions,
  viewRegion,
} from "./evidence/rectify";
import type { EvidenceRegion } from "./evidence/region";
import {
  type Isolation,
  type IsolationOptions,
  isolateLettering,
} from "./isolation/isolate";
import {
  labelFromText,
  type Reading,
  type Recognizer,
  readLettering,
} from "./recognition/recognizer";
import type { TargetFace } from "./recovery/naming";
import {
  DEFAULT_METRICS,
  distinctLetters,
  type RecoveredLetter,
  type RecoveryMetrics,
  recoverLetters,
} from "./recovery/recover";

export interface ReconstructionRequest {
  readonly evidence: Evidence;
  readonly isolation?: IsolationOptions;
  readonly metrics?: RecoveryMetrics;
  /** Reads the letters. Without one, every letter needs a label from `text`. */
  readonly recognizer?: Recognizer;
  readonly region: EvidenceRegion;
  readonly target: TargetFace;
  /**
   * What a person says the lettering reads, one string for each line. It
   * replaces the recogniser's labels. See `labelFromText`.
   */
  readonly text?: readonly string[];
  readonly view?: ViewOptions;
}

export interface Reconstruction {
  /** One recovered letter for each distinct character, ready to propose as candidates. */
  readonly distinct: readonly RecoveredLetter[];
  readonly isolation: Isolation;
  readonly metrics: RecoveryMetrics;
  readonly readings: readonly Reading[];
  /** Every labelled letter, traced. */
  readonly recovered: readonly RecoveredLetter[];
  readonly view: RegionView;
}

/** Reconstructs the lettering in one region of evidence. */
export const reconstruct = (request: ReconstructionRequest): Reconstruction => {
  const view = viewRegion(
    request.evidence.pixels,
    request.region,
    request.view
  );
  const isolation = isolateLettering(view.image, request.isolation);
  const unread: Reading[] = isolation.lines.flatMap((line, lineIndex) =>
    line.letters.map((letter, index) => ({
      guesses: [],
      index,
      labelledBy: "recognizer",
      letter,
      line: lineIndex,
    }))
  );
  const read = request.recognizer
    ? readLettering(isolation.lines, request.recognizer)
    : unread;
  const readings = request.text ? labelFromText(read, request.text) : read;
  const metrics = request.metrics ?? DEFAULT_METRICS;
  const recovered = recoverLetters({
    evidenceId: request.evidence.id,
    lines: isolation.lines,
    metrics,
    readings,
    target: request.target,
    view,
  });
  return {
    distinct: distinctLetters(recovered, isolation.lines),
    isolation,
    metrics,
    readings,
    recovered,
    view,
  };
};
