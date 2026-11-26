import type {
  EmbeddingModelV4,
  ImageModelV4,
  LanguageModelV4,
} from "@ai-sdk/provider";
import type {
  ModelKind,
  ProviderModelDefinition,
} from "../../model-definition";
import type { Provider } from "../../provider";

export interface FakeProviderOptions {
  available?: boolean;
  defaults?: Partial<Record<ModelKind, string>>;
  kinds?: ("embedding" | "image")[];
  models?: ProviderModelDefinition[];
}

export interface FakeProvider extends Provider {
  available: boolean;
  calls: string[];
  disposed: number;
}

const DEFAULT_MODELS: ProviderModelDefinition[] = [
  { id: "smart", kind: "text", modelId: "upstream/smart" },
  { id: "embed", kind: "embedding", modelId: "upstream/embed" },
];

export function fakeProvider(
  id: string,
  options: FakeProviderOptions = {}
): FakeProvider {
  const kinds = new Set(options.kinds ?? ["embedding", "image"]);
  const stub = (kind: string, modelId: string) =>
    ({ kind, modelId, provider: id }) as never;
  const provider: FakeProvider = {
    available: options.available ?? true,
    calls: [],
    defaults: options.defaults ?? { embedding: "embed", text: "smart" },
    dispose: () => {
      provider.disposed += 1;
      return Promise.resolve();
    },
    disposed: 0,
    id,
    languageModel: (modelId): LanguageModelV4 => {
      provider.calls.push(`text:${modelId}`);
      return stub("text", modelId);
    },
    models: options.models ?? DEFAULT_MODELS,
  };
  if (kinds.has("embedding")) {
    provider.embeddingModel = (modelId): EmbeddingModelV4 => {
      provider.calls.push(`embedding:${modelId}`);
      return stub("embedding", modelId);
    };
  }
  if (kinds.has("image")) {
    provider.imageModel = (modelId): ImageModelV4 => {
      provider.calls.push(`image:${modelId}`);
      return stub("image", modelId);
    };
  }
  return provider;
}
