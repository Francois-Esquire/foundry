import { createReplicate } from "@ai-sdk/replicate";
import { modelErrors } from "./errors";
import type { Provider } from "./provider";
import { vendorClient } from "./provider";
import type { ProviderModelDefinition } from "./types";

export interface ReplicateProviderConfig {
  apiToken?: string;
}

export interface ReplicateProviderOptions {
  config?: ReplicateProviderConfig;
  id?: string;
  models?: ProviderModelDefinition[];
}

/**
 * Facts only for what `@ai-sdk/replicate` serves: its model-id unions name
 * image and video and nothing else. The video MIME is the adapter's own
 * declaration (`video/mp4`, hard-coded in its result); the image MIME is the
 * model's documented default output format, which the vendor instrument is
 * what proves.
 */
export const REPLICATE_DEFAULT_MODELS: ProviderModelDefinition[] = [
  {
    id: "black-forest-labs/flux-schnell",
    kind: "image",
    label: "FLUX.1 [schnell]",
    modelId: "black-forest-labs/flux-schnell",
    operations: [
      {
        delivery: "whole",
        inputs: ["direction"],
        mode: "request",
        operation: "generate-image",
        outputs: ["image/webp"],
        required: ["direction"],
      },
    ],
    vendor: "Black Forest Labs",
  },
  {
    // No image input: the adapter forwards one to every video model alike, and
    // that is the adapter's shape rather than evidence about this model.
    id: "minimax/video-01",
    kind: "video",
    label: "MiniMax Video 01",
    modelId: "minimax/video-01",
    operations: [
      {
        delivery: "whole",
        inputs: ["direction"],
        mode: "request",
        operation: "generate-video",
        outputs: ["video/mp4"],
        required: ["direction"],
      },
    ],
    vendor: "MiniMax",
  },
];

/** Replicate, through the AI SDK adapter. The token lives here and nowhere else. */
export function replicateProvider(
  options: ReplicateProviderOptions = {}
): Provider {
  const vendor = vendorClient(options.config ?? {}, (config) =>
    createReplicate({ apiToken: config.apiToken ?? "" })
  );

  const provider: Provider = {
    get available() {
      return vendor.config.apiToken !== undefined;
    },
    id: options.id ?? "replicate",
    imageModel: (modelId) => vendor.client.imageModel(modelId),
    languageModel: () => {
      throw modelErrors.CAPABILITY_UNSUPPORTED({
        capability: "text models",
        provider: provider.id,
      });
    },
    models: options.models ?? REPLICATE_DEFAULT_MODELS,
    offline: false,
    videoModel: (modelId) => vendor.client.videoModel(modelId),
  };
  return provider;
}
