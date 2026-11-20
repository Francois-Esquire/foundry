import {
  createGateway,
  extractReasoningMiddleware,
  wrapLanguageModel,
} from "ai";
import { parseVercelRest } from "./catalog/vercel";
import type { Provider } from "./provider";
import { vendorClient } from "./provider";
import type { ModelKind, ProviderModelDefinition } from "./types";

export interface VercelProviderConfig {
  apiKey?: string;
  baseURL?: string;
}

export interface VercelProviderOptions {
  config?: VercelProviderConfig;
  defaults?: Partial<Record<ModelKind, string>>;
  id?: string;
  models?: ProviderModelDefinition[];
}

const VERCEL_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
const TRAILING_SLASHES = /\/+$/;

export async function vercelModels(
  config: VercelProviderConfig = {},
  { signal }: { readonly signal?: AbortSignal } = {}
): Promise<ProviderModelDefinition[]> {
  const url = new URL(config.baseURL ?? VERCEL_GATEWAY_BASE_URL);
  url.pathname = `${url.pathname.replace(TRAILING_SLASHES, "")}/models`;
  const response = await fetch(url.toString(), {
    headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`GET /models answered ${response.status}`);
  }
  const payload: unknown = await response.json().catch(() => undefined);
  signal?.throwIfAborted();
  const models = parseVercelRest(payload);
  if (models === undefined) {
    throw new Error("GET /models answered without a valid Vercel model list");
  }
  return models;
}

export function vercelProvider(options: VercelProviderOptions = {}): Provider {
  const vendor = vendorClient(options.config ?? {}, build);

  return {
    get available() {
      return vendor.config.apiKey !== undefined;
    },
    ...(options.defaults ? { defaults: options.defaults } : {}),
    embeddingModel: (modelId) => vendor.client.embeddingModel(modelId),
    id: options.id ?? "vercel",
    imageModel: (modelId) => vendor.client.imageModel(modelId),
    languageModel: (modelId) =>
      wrapLanguageModel({
        middleware: extractReasoningMiddleware({ tagName: "think" }),
        model: vendor.client.languageModel(modelId),
      }),
    models: options.models ?? [],
    offline: false,
  };
}

function build(config: VercelProviderConfig) {
  return createGateway({ apiKey: config.apiKey, baseURL: config.baseURL });
}
