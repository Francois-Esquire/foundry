/**
 * The strategy for any model that is shown the style reference sheet and
 * asked for a sheet of the missing glyphs. What kind of sheet comes back is
 * the only thing that tells an image model from a vector model.
 */
import type { ImageCodec } from "../raster/image-codec";
import type { SheetLayout } from "../sheet/layout";
import type { ModelClient } from "./model-client";
import { buildSheetRequest } from "./sheet-request";
import {
  type GenerationStrategy,
  type RawOutput,
  StrategyUnavailableError,
} from "./strategy";

export interface ModelStrategyOptions<Answer> {
  /** The provider to call. Without one the strategy is unavailable. */
  readonly client?: ModelClient<Answer>;
  readonly clock?: () => Date;
  /** Encodes the reference sheet for sending. */
  readonly codec: Pick<ImageCodec, "encodePng">;
  /** The widest and tallest sheet to ask for, in pixels. */
  readonly maxSize?: number;
}

interface ModelKind<Answer> {
  readonly kind: "image-model" | "vector-model";
  /** The kind in words, as a sentence starts with it: "Image model". */
  readonly label: string;
  /** The model's answer as the sheet extraction reads. */
  readonly toRaw: (answer: Answer, layout: SheetLayout) => RawOutput;
}

const DEFAULT_SIZE = 1024;

export const modelStrategy = <Answer>(
  { kind, label, toRaw }: ModelKind<Answer>,
  { client, clock, codec, maxSize = DEFAULT_SIZE }: ModelStrategyOptions<Answer>
): GenerationStrategy => {
  const unconfigured = `No ${label.toLowerCase()} is configured.`;
  return {
    availability: () =>
      client?.availability() ?? { available: false, reason: unconfigured },
    async generate(request) {
      if (!client) {
        throw new StrategyUnavailableError(unconfigured);
      }
      const availability = client.availability();
      if (!availability.available) {
        throw new StrategyUnavailableError(availability.reason);
      }
      const sheet = await buildSheetRequest(request, codec, maxSize);
      const createdAt = (clock?.() ?? new Date()).toISOString();
      const result = await client.generate({
        prompt: sheet.prompt,
        referenceImages: [sheet.referenceImage],
        signal: request.signal,
        size: sheet.size,
      });
      return {
        createdAt,
        producedBy: kind,
        raw: toRaw(result, sheet.layout),
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
    id: kind,
    kind,
    name: client ? `${label}: ${client.model}` : label,
  };
};
