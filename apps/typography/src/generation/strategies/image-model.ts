/**
 * The image model strategy: shows a model the style reference sheet, asks
 * for a sheet of the missing glyphs, and hands the picture on to extraction.
 */
import type { ImageCodec } from "../raster/image-codec";
import type { ImageModelClient } from "./model-client";
import { buildSheetRequest } from "./sheet-request";
import {
  type Availability,
  type GenerationStrategy,
  StrategyUnavailableError,
} from "./strategy";

export interface ImageModelOptions {
  /** The provider to call. Without one the strategy is unavailable. */
  readonly client?: ImageModelClient;
  readonly clock?: () => Date;
  /** Encodes the reference sheet for sending. */
  readonly codec: Pick<ImageCodec, "encodePng">;
  /** The widest and tallest sheet to ask for, in pixels. */
  readonly maxSize?: number;
}

const DEFAULT_SIZE = 1024;

const availabilityOf = (client: ImageModelClient | undefined): Availability =>
  client?.availability() ?? {
    available: false,
    reason: "No image model is configured.",
  };

export const imageModelStrategy = (
  options: ImageModelOptions
): GenerationStrategy => ({
  availability: () => availabilityOf(options.client),
  async generate(request) {
    const availability = availabilityOf(options.client);
    if (!(options.client && availability.available)) {
      throw new StrategyUnavailableError(
        availability.available
          ? "No image model is configured."
          : availability.reason
      );
    }
    const sheet = await buildSheetRequest(
      request,
      options.codec,
      options.maxSize ?? DEFAULT_SIZE
    );
    const createdAt = (options.clock?.() ?? new Date()).toISOString();
    const result = await options.client.generate({
      prompt: sheet.prompt,
      referenceImages: [sheet.referenceImage],
      signal: request.signal,
      size: sheet.size,
    });
    return {
      createdAt,
      producedBy: "image-model",
      raw: { image: result.image, kind: "sheet-image", layout: sheet.layout },
      recorded: false,
      sent: {
        parameters: result.parameters,
        prompt: sheet.prompt,
        referenceSheet: sheet.referenceSvg,
      },
      unmade: [],
      usage: {
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
        model: result.model,
      },
    };
  },
  id: "image-model",
  kind: "image-model",
  name: options.client ? `Image model: ${options.client.model}` : "Image model",
});
