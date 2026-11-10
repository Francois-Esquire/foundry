/**
 * What a coordinated run is expected to cost, asked the way the strategies
 * really call a model: one sheet for each weight, holding every target.
 */
import { type CostEstimate, estimateCost } from "~/generation/family/cost";
import { listedRateFor } from "~/generation/family/listed-rates";
import type { StrategyKind } from "~/generation/strategies/strategy";

export interface FamilyCostQuestion {
  readonly kind: StrategyKind;
  /** The model the strategy would call, as its provider names it. */
  readonly model?: string;
  /** How many glyphs each weight is asked for. */
  readonly targets: number;
  readonly weights: number;
}

export const familyEstimate = ({
  kind,
  model,
  targets,
  weights,
}: FamilyCostQuestion): CostEstimate =>
  estimateCost({
    faces: weights,
    // Both model strategies send one sheet request for a face, whatever it holds.
    glyphsPerCall: Math.max(1, targets),
    kind,
    rate: model === undefined ? undefined : listedRateFor(model),
    targets,
  });

/** The figure as a sentence, or the plain fact that there is none. */
export const estimateHeadline = ({ calls, usd }: CostEstimate): string => {
  const asked = `${calls} ${calls === 1 ? "call" : "calls"} to the model`;
  return usd === undefined
    ? `${asked}. No dollar figure can be given.`
    : `${asked}, about $${usd.toFixed(2)}.`;
};
