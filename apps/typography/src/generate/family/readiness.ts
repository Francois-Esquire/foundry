import { FEWEST_WEIGHTS } from "~/generation/family/weights";
import type { StrategyOption } from "~/generation/strategies/offering";
import { emptyReason, type Readiness } from "../request-draft";
import type { Draft } from "../session";

/**
 * Whether a run across weights can start, and the reason when it cannot.
 * `weights` counts the different weights the run would use, and `leftOut`
 * the characters asked for that the face already has.
 */
export const readinessOf = (
  option: StrategyOption | undefined,
  weights: number,
  targets: number,
  leftOut: number,
  draft: Draft
): Readiness => {
  if (option && !option.availability.available) {
    return { ready: false, reason: option.availability.reason };
  }
  if (weights < FEWEST_WEIGHTS) {
    return { ready: false, reason: "Choose at least two different weights." };
  }
  if (targets > 0) {
    return { ready: true };
  }
  return {
    ready: false,
    reason:
      leftOut > 0
        ? "Every character asked for is already in the face, so there is nothing to generate."
        : emptyReason(draft),
  };
};
