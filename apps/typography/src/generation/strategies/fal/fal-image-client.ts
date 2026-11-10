/** An image model on fal: reference pictures and a prompt in, one picture out. */
import { toDataUri } from "../../raster/image-codec";
import type { ImageModelClient } from "../model-client";
import {
  downloadFalFile,
  type FalOptions,
  falAvailability,
  runFalModel,
} from "./fal-request";

export interface FalImageOptions extends FalOptions {
  /** Rendering quality, as the endpoint names its levels. */
  readonly quality?: "auto" | "high" | "low" | "max" | "medium" | "xhigh";
}

const DEFAULT_ENDPOINT = "openai/gpt-image-2.6/flare/edit";
const DEFAULT_QUALITY = "low";

/** A client for fal's image editing endpoints. It reports the cost only if fal ever states it; today it does not. */
export const falImageClient = (options: FalImageOptions): ImageModelClient => {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const quality = options.quality ?? DEFAULT_QUALITY;
  return {
    availability: () => falAvailability(options.key),
    async generate(call) {
      const parameters = {
        image_size: `${call.size.width}x${call.size.height}`,
        output_format: "png",
        quality,
      };
      const { files, latencyMs } = await runFalModel(
        { ...options, endpoint },
        {
          image_size: call.size,
          image_urls: call.referenceImages.map(toDataUri),
          output_format: parameters.output_format,
          prompt: call.prompt,
          quality,
        },
        call.signal
      );
      const [first] = files;
      return {
        image: await downloadFalFile(
          options,
          first ?? {},
          "image/png",
          call.signal
        ),
        latencyMs,
        model: endpoint,
        parameters,
      };
    },
    model: endpoint,
  };
};
