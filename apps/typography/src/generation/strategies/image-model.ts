/**
 * The image model strategy: shows a model the style reference sheet, asks
 * for a sheet of the missing glyphs, and hands the picture on to extraction.
 */
import type { ImageAnswer } from "./model-client";
import { type ModelStrategyOptions, modelStrategy } from "./model-strategy";

export const imageModelStrategy = (
  options: ModelStrategyOptions<ImageAnswer>
) =>
  modelStrategy(
    {
      kind: "image-model",
      label: "Image model",
      toRaw: ({ image }, layout) => ({ image, kind: "sheet-image", layout }),
    },
    options
  );
