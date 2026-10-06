import { createFal } from "@ai-sdk/fal";
import { createFalClient } from "@fal-ai/client";
import { modelErrors } from "../errors";
import type { LiveAccess } from "../live/types";
import type { Provider, ProviderBinding } from "../provider";
import type { ProviderModelDefinition } from "../types";
import { FAL_DEFAULT_MODELS } from "./catalog";
import type { FalFetch, FalRuntime } from "./client";
import { buildFalRuntime } from "./client";
import { falGrant } from "./grant";
import { falMediaModel } from "./media";

export interface FalProviderConfig {
  apiKey?: string;
  /** Injection seam for the token mint and result downloads. */
  fetch?: FalFetch;
  /**
   * When set, `grant` hands back this URL instead of minting a token. The
   * single switch behind the decided proxy fallback; no proxy is built here.
   */
  proxyUrl?: string;
}

export interface FalProviderOptions {
  config?: FalProviderConfig;
  id?: string;
  models?: ProviderModelDefinition[];
}

/**
 * Registers `fal` while `falApiKey` is present. A removed key scrubs the
 * Provider's client before the drop, so no configured runtime is left behind.
 */
export const falBinding: ProviderBinding<FalProviderConfig> = {
  clear: (provider) => provider.configure?.({ apiKey: undefined }),
  create: (config) => falProvider({ config }),
  fromCredentials: (credentials) =>
    credentials.falApiKey ? { apiKey: credentials.falApiKey } : null,
  id: "fal",
  update: (provider, config) => provider.configure?.({ ...config }),
};

/**
 * Live access for the key-owning process itself: the configured client rides
 * on the access, so only a holder of the key can construct one. `grant` never
 * produces it; it is for opening a live interaction in this process.
 */
export function falCredentialAccess(apiKey: string): LiveAccess {
  return {
    client: createFalClient({ credentials: apiKey }),
    kind: "credential",
  };
}

/**
 * FAL. Request-mode image, video, speech, and transcription run through the AI
 * SDK adapter; segmentation, music, and sound effects run through the native
 * client behind `mediaModel`; live access is a grant. The key lives here and
 * nowhere else.
 */
export function falProvider(
  options: FalProviderOptions = {}
): Provider<FalProviderConfig> {
  let config = options.config ?? {};
  let sdk = createFal(sdkSettings(config));
  let runtime = runtimeFor(config);

  const provider: Provider<FalProviderConfig> = {
    get available() {
      return runtime !== null;
    },
    configure: (patch) => {
      config = { ...config, ...patch };
      sdk = createFal(sdkSettings(config));
      runtime = runtimeFor(config);
    },
    grant: (modelId, operation) =>
      falGrant({
        modelId,
        models: provider.models,
        operation,
        ...(config.proxyUrl === undefined ? {} : { proxyUrl: config.proxyUrl }),
        providerId: provider.id,
        runtime,
      }),
    harness: "studio",
    id: options.id ?? "fal",
    // `createFal()` names these `speech` and `transcription`, not the
    // `ProviderV4` optional `speechModel`/`transcriptionModel`, so `fromSdk`
    // would type-check and then drop both kinds. They are mapped by hand.
    imageModel: (modelId) => sdk.imageModel(modelId),
    languageModel: () => {
      throw modelErrors.CAPABILITY_UNSUPPORTED({
        capability: "text models",
        provider: provider.id,
      });
    },
    mediaModel: (modelId) => falMediaModel(modelId, () => runtime),
    models: options.models ?? FAL_DEFAULT_MODELS,
    offline: false,
    speechModel: (modelId) => sdk.speech(modelId),
    transcriptionModel: (modelId) => sdk.transcription(modelId),
    videoModel: (modelId) => sdk.videoModel(modelId),
  };
  return provider;
}

function sdkSettings(config: FalProviderConfig) {
  return {
    // The adapter falls back to FAL_API_KEY/FAL_KEY when this is undefined;
    // an empty string keeps an unkeyed provider from borrowing the ambient one.
    apiKey: config.apiKey ?? "",
  };
}

function runtimeFor(config: FalProviderConfig): FalRuntime | null {
  return config.apiKey === undefined
    ? null
    : buildFalRuntime(config.apiKey, config.fetch);
}
