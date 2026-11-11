/**
 * The vector model strategy: the same request as the image strategy, to a
 * model that answers in SVG, so the glyphs can keep the model's own curves.
 */
import type { VectorAnswer } from "./model-client";
import { type ModelStrategyOptions, modelStrategy } from "./model-strategy";

export const vectorModelStrategy = (
  options: ModelStrategyOptions<VectorAnswer>
) =>
  modelStrategy(
    {
      kind: "vector-model",
      label: "Vector model",
      toRaw: ({ svg }, layout) => ({ kind: "sheet-svg", layout, svg }),
    },
    options
  );
