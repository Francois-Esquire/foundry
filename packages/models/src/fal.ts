import { createFal } from "@ai-sdk/fal";
import { modelErrors } from "./errors";
import type { FalFetch, FalRuntime } from "./fal/client";
import { buildFalRuntime } from "./fal/client";
import { FAL_DEFAULT_MODELS } from "./fal/default-models";
import { falGrant } from "./fal/grant";
import { falMediaModel } from "./fal/media";
import type { LiveAccess } from "./live/types";
import type { ProviderModelDefinition } from "./model-definition";
import type { Provider } from "./provider";
import { vendorClient } from "./provider";

export interface FalProviderConfig {
  apiKey?: string;
  fetch?: FalFetch;
  proxyUrl?: string;
}

export interface FalProviderOptions {
  config?: FalProviderConfig;
  id?: string;
  models?: ProviderModelDefinition[];
}

export function falCredentialAccess(apiKey: string): LiveAccess {
  return { credentials: apiKey, kind: "credential" };
}

export function falProvider(options: FalProviderOptions = {}): Provider {
  const vendor = vendorClient(options.config ?? {}, (config) => ({
    runtime: runtimeFor(config),
    sdk: createFal(sdkSettings(config)),
  }));

  const provider: Provider = {
    get available() {
      return vendor.client.runtime !== null;
    },
    grant: (modelId, operation) =>
      falGrant({
        modelId,
        models: provider.models,
        operation,
        ...(vendor.config.proxyUrl === undefined
          ? {}
          : { proxyUrl: vendor.config.proxyUrl }),
        providerId: provider.id,
        runtime: vendor.client.runtime,
      }),
    id: options.id ?? "fal",
    imageModel: (modelId) => vendor.client.sdk.imageModel(modelId),
    languageModel: () => {
      throw modelErrors.CAPABILITY_UNSUPPORTED({
        capability: "text models",
        provider: provider.id,
      });
    },
    mediaModel: (modelId) =>
      falMediaModel(modelId, () => vendor.client.runtime),
    models: options.models ?? FAL_DEFAULT_MODELS,
    offline: false,
    speechModel: (modelId) => vendor.client.sdk.speech(modelId),
    transcriptionModel: (modelId) => vendor.client.sdk.transcription(modelId),
    videoModel: (modelId) => vendor.client.sdk.videoModel(modelId),
  };
  return provider;
}

function sdkSettings(config: FalProviderConfig) {
  return {
    apiKey: config.apiKey ?? "",
  };
}

function runtimeFor(config: FalProviderConfig): FalRuntime | null {
  return config.apiKey === undefined
    ? null
    : buildFalRuntime(config.apiKey, config.fetch);
}
