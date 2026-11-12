import { strategyName } from "~/generation/strategies/offering";
import type { StrategyKind } from "~/generation/strategies/strategy";

export const ORDER: readonly StrategyKind[] = [
  "procedural",
  "image-model",
  "vector-model",
  "recorded-run",
];

export const SUMMARIES: Readonly<Record<StrategyKind, string>> = {
  "image-model":
    "Sends the style reference sheet to an image model on fal and traces the picture it returns. A paid call, made with your key.",
  procedural:
    "Builds accented letters from a base letter and its marks, by rule, on this machine. No model is called and nothing leaves it.",
  "recorded-run":
    "Replays real model output that was saved earlier. No model is called, and every candidate is labelled as recorded.",
  "vector-model":
    "Puts the style reference sheet on fal's storage, asking for it to be removed after an hour, and asks a vector model on fal to follow it. The model answers in SVG, so glyphs keep its own curves. A paid call, made with your key.",
};

/** The name a strategy goes by in provenance, in words for a label. */
export const strategyLabel = (strategy: string): string => {
  if (strategy === "synthetic-sheet") {
    return "Synthetic sheet, no model";
  }
  return strategyName(strategy);
};
