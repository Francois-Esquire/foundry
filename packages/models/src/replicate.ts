import { createReplicate } from "@ai-sdk/replicate";
import { modelErrors } from "./errors";
import type { Provider, ProviderBinding } from "./provider";
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
/** Registers `replicate` while `replicateApiToken` is present; a removed token scrubs the client first. */
export const replicateBinding: ProviderBinding<ReplicateProviderConfig> = {
  clear: (provider) => provider.configure?.({ apiToken: undefined }),
  create: (config) => replicateProvider({ config }),
  fromCredentials: (credentials) =>
    credentials.replicateApiToken
      ? { apiToken: credentials.replicateApiToken }
      : null,
  id: "replicate",
  update: (provider, config) => provider.configure?.({ ...config }),
};

export function replicateProvider(
  options: ReplicateProviderOptions = {}
): Provider<ReplicateProviderConfig> {
  let config = options.config ?? {};
  let sdk = createReplicate({ apiToken: config.apiToken ?? "" });

  const provider: Provider<ReplicateProviderConfig> = {
    get available() {
      return config.apiToken != null;
    },
    configure: (patch) => {
      config = { ...config, ...patch };
      sdk = createReplicate({ apiToken: config.apiToken ?? "" });
    },
    harness: "studio",
    id: options.id ?? "replicate",
    imageModel: (modelId) => sdk.imageModel(modelId),
    languageModel: () => {
      throw modelErrors.CAPABILITY_UNSUPPORTED({
        capability: "text models",
        provider: provider.id,
      });
    },
    models: options.models ?? REPLICATE_DEFAULT_MODELS,
    offline: false,
    videoModel: (modelId) => sdk.videoModel(modelId),
  };
  return provider;
}
