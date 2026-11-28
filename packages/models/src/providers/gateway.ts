import {
  OpenAICompatibleChatLanguageModel,
  OpenAICompatibleEmbeddingModel,
  OpenAICompatibleImageModel,
} from "@ai-sdk/openai-compatible";
import type { ModelKind, ProviderModelDefinition } from "../model-definition";
import type { Provider } from "../provider";

export interface GatewayProviderConfig {
  apiKey?: string;
  baseURL: string;
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
}

export interface GatewayProviderOptions {
  config: GatewayProviderConfig;
  defaults?: Partial<Record<ModelKind, string>>;
  id?: string;
  models: ProviderModelDefinition[];
}

const TRAILING_SLASHES = /\/+$/;

function urlFor(config: GatewayProviderConfig, path: string): string {
  const base = config.baseURL.replace(TRAILING_SLASHES, "");
  const target = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(config.queryParams ?? {})) {
    target.searchParams.set(key, value);
  }
  return target.toString();
}

function headersFor(config: GatewayProviderConfig): Record<string, string> {
  return {
    ...(config.apiKey?.trim()
      ? { Authorization: `Bearer ${config.apiKey}` }
      : {}),
    ...config.headers,
  };
}

export async function gatewayModels(
  config: GatewayProviderConfig,
  options: { readonly signal?: AbortSignal } = {}
): Promise<ProviderModelDefinition[]> {
  const response = await fetch(urlFor(config, "/models"), {
    headers: headersFor(config),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`GET /models answered ${response.status}`);
  }
  const body: unknown = await response.json().catch(() => undefined);
  const data = (body as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) {
    throw new Error("GET /models answered without a model list");
  }
  const ids = data.map((model: unknown) => {
    const id = (model as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || id === "") {
      throw new Error("GET /models answered a model without an id");
    }
    return id;
  });
  return [...new Set(ids)].map((id) => ({ id, kind: "text", modelId: id }));
}

export function gatewayProvider(options: GatewayProviderOptions): Provider {
  const id = options.id ?? "gateway";
  const { config } = options;

  const url = ({ path }: { path: string }) => urlFor(config, path);
  const headers = () => headersFor(config);
  const settings = () => ({ headers, includeUsage: true, provider: id, url });

  return {
    get available() {
      return Boolean(config.baseURL.trim()) && Boolean(config.apiKey?.trim());
    },
    ...(options.defaults ? { defaults: options.defaults } : {}),
    embeddingModel: (modelId) =>
      new OpenAICompatibleEmbeddingModel(modelId, settings()),
    id,
    imageModel: (modelId) =>
      new OpenAICompatibleImageModel(modelId, settings()),
    languageModel: (modelId) =>
      new OpenAICompatibleChatLanguageModel(modelId, settings()),
    models: options.models,
  };
}
