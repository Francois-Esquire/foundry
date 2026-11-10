/**
 * A vector model on fal: reference pictures and a prompt in, one SVG out. The
 * model fetches its reference pictures by address and refuses one sent inside
 * the request, so each is put on fal's storage first.
 */
import type { VectorModelClient } from "../model-client";
import {
  downloadFalFile,
  type FalOptions,
  falAvailability,
  runFalModel,
  uploadFalFile,
} from "./fal-request";

export interface FalVectorOptions extends FalOptions {
  readonly quality?: "high" | "low" | "medium";
}

const DEFAULT_ENDPOINT = "ideogram/vector/text-to-vector";
const DEFAULT_QUALITY = "low";
/** The aspect ratios the endpoint accepts, as width over height. */
const ASPECT_RATIOS: readonly (readonly [string, number])[] = [
  ["1:1", 1],
  ["4:3", 4 / 3],
  ["3:4", 3 / 4],
  ["3:2", 3 / 2],
  ["2:3", 2 / 3],
  ["16:9", 16 / 9],
  ["9:16", 9 / 16],
  ["2:1", 2],
  ["1:2", 1 / 2],
];

const nearestAspectRatio = (width: number, height: number): string => {
  const wanted = width / height;
  let best = "1:1";
  let distance = Number.POSITIVE_INFINITY;
  for (const [name, ratio] of ASPECT_RATIOS) {
    if (Math.abs(Math.log(ratio / wanted)) < distance) {
      best = name;
      distance = Math.abs(Math.log(ratio / wanted));
    }
  }
  return best;
};

/** A client for fal's text-to-vector endpoints. */
export const falVectorClient = (
  options: FalVectorOptions
): VectorModelClient => {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const quality = options.quality ?? DEFAULT_QUALITY;
  return {
    availability: () => falAvailability(options.key),
    async generate(call) {
      const parameters = {
        aspect_ratio: nearestAspectRatio(call.size.width, call.size.height),
        num_images: 1,
        quality,
      };
      const references = await Promise.all(
        call.referenceImages.map((image, index) =>
          uploadFalFile(options, image, `reference-${index + 1}`, call.signal)
        )
      );
      const { files, latencyMs } = await runFalModel(
        { ...options, endpoint },
        { ...parameters, image_urls: references, prompt: call.prompt },
        call.signal
      );
      const [first] = files;
      const file = await downloadFalFile(
        options,
        first ?? {},
        "image/svg+xml",
        call.signal
      );
      return {
        latencyMs,
        model: endpoint,
        parameters,
        svg: new TextDecoder().decode(file.bytes),
      };
    },
    model: endpoint,
  };
};
