/**
 * The vector model strategy: the same request as the image strategy, to a
 * model that answers in SVG, so the glyphs can keep the model's own curves.
 */
import type { ImageCodec } from "../raster/image-codec";
import type { VectorModelClient } from "./model-client";
import { buildSheetRequest } from "./sheet-request";
import {
  type Availability,
  type GenerationStrategy,
  StrategyUnavailableError,
} from "./strategy";

export interface VectorModelOptions {
  /** The provider to call. Without one the strategy is unavailable. */
  readonly client?: VectorModelClient;
  readonly clock?: () => Date;
  /** Encodes the reference sheet for sending. */
  readonly codec: Pick<ImageCodec, "encodePng">;
  readonly maxSize?: number;
}

const DEFAULT_SIZE = 1024;

const availabilityOf = (client: VectorModelClient | undefined): Availability =>
  client?.availability() ?? {
    available: false,
    reason: "No vector model is configured.",
  };

export const vectorModelStrategy = (
  options: VectorModelOptions
): GenerationStrategy => ({
  availability: () => availabilityOf(options.client),
  async generate(request) {
    const availability = availabilityOf(options.client);
    if (!(options.client && availability.available)) {
      throw new StrategyUnavailableError(
        availability.available
          ? "No vector model is configured."
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
      producedBy: "vector-model",
      raw: { kind: "sheet-svg", layout: sheet.layout, svg: result.svg },
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
  id: "vector-model",
  kind: "vector-model",
  name: options.client
    ? `Vector model: ${options.client.model}`
    : "Vector model",
});
