import type {
  EmbeddingModelV4,
  ImageModelV4,
  LanguageModelV4,
  ProviderV4,
} from "@ai-sdk/provider";
import { modelErrors } from "./errors";
import type { ModelKind, ProviderModelDefinition } from "./model-definition";

export type TurnLimit = "native" | "steps" | "unsupported";

export interface LanguageModelOptions {
  nativeMaxTurns?: number;
  workingDirectory?: string;
}

export interface Provider {
  readonly available: boolean;

  readonly defaults?: Partial<Record<ModelKind, string>>;
  dispose?(): Promise<void>;
  embeddingModel?(modelId: string): EmbeddingModelV4;
  readonly id: string;
  imageModel?(modelId: string): ImageModelV4;

  languageModel(
    modelId: string,
    options?: LanguageModelOptions
  ): LanguageModelV4;
  readonly models: readonly ProviderModelDefinition[];
  readonly turnLimit?: TurnLimit;
}

export function fromSdk(
  meta: Omit<Provider, "languageModel" | "embeddingModel" | "imageModel">,
  sdk: ProviderV4
): Provider {
  return {
    ...meta,
    embeddingModel: (modelId) => sdk.embeddingModel(modelId),
    imageModel: (modelId) => sdk.imageModel(modelId),
    languageModel: (modelId) => sdk.languageModel(modelId),
  };
}

export function catalogRow(
  provider: Provider,
  kind: ModelKind,
  id?: string
): ProviderModelDefinition {
  if (id !== undefined) {
    const row = provider.models.find(
      (entry) => entry.id === id && entry.kind === kind
    );
    if (row) {
      return row;
    }
    const other = provider.models.find((entry) => entry.id === id);
    if (other) {
      throw modelErrors.MODEL_KIND_MISMATCH({
        actual: other.kind,
        expected: kind,
        model: id,
        provider: provider.id,
      });
    }
    throw modelErrors.MODEL_NOT_FOUND({ model: id, searched: [provider.id] });
  }
  const preferred = provider.defaults?.[kind];
  const row =
    provider.models.find(
      (entry) => entry.id === preferred && entry.kind === kind
    ) ?? provider.models.find((entry) => entry.kind === kind);
  if (!row) {
    throw modelErrors.NO_MODEL_OF_KIND({ kind, provider: provider.id });
  }
  return row;
}

export function servesKind(provider: Provider, kind: ModelKind): boolean {
  return provider.models.some((m) => m.kind === kind);
}
