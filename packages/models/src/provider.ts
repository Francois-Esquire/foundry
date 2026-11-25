import type {
  EmbeddingModelV4,
  Experimental_VideoModelV4,
  ImageModelV4,
  LanguageModelV4,
  ProviderV4,
  SpeechModelV4,
  TranscriptionModelV4,
} from "@ai-sdk/provider";
import type { CapabilityFact, OperationName } from "./capability";
import { modelErrors } from "./errors";
import type { LiveAccess } from "./live/types";
import type { MediaModel } from "./media";
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
  grant?(modelId: string, operation: OperationName): Promise<LiveAccess>;
  readonly id: string;
  imageModel?(modelId: string): ImageModelV4;

  languageModel(
    modelId: string,
    options?: LanguageModelOptions
  ): LanguageModelV4;
  mediaModel?(modelId: string): MediaModel;
  readonly models: readonly ProviderModelDefinition[];
  readonly offline: boolean;
  setOffline?(offline: boolean): void | Promise<void>;
  speechModel?(modelId: string): SpeechModelV4;
  transcriptionModel?(modelId: string): TranscriptionModelV4;
  readonly turnLimit?: TurnLimit;
  videoModel?(modelId: string): Experimental_VideoModelV4;
}

export function fromSdk(
  meta: Omit<
    Provider,
    | "languageModel"
    | "embeddingModel"
    | "imageModel"
    | "transcriptionModel"
    | "speechModel"
    | "videoModel"
  >,
  sdk: ProviderV4 & { videoModel?(modelId: string): Experimental_VideoModelV4 }
): Provider {
  const transcriptionModel = sdk.transcriptionModel?.bind(sdk);
  const speechModel = sdk.speechModel?.bind(sdk);
  const videoModel = sdk.videoModel?.bind(sdk);
  return {
    ...meta,
    embeddingModel: (modelId) => sdk.embeddingModel(modelId),
    imageModel: (modelId) => sdk.imageModel(modelId),
    languageModel: (modelId) => sdk.languageModel(modelId),
    ...(transcriptionModel ? { transcriptionModel } : {}),
    ...(speechModel ? { speechModel } : {}),
    ...(videoModel ? { videoModel } : {}),
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

const DERIVED_FACTS: Partial<Record<ModelKind, readonly CapabilityFact[]>> = {
  image: [
    {
      delivery: "whole",
      inputs: ["direction"],
      mode: "request",
      operation: "generate-image",
      outputs: ["image/png"],
      required: ["direction"],
    },
  ],
  speech: [
    {
      delivery: "whole",
      inputs: ["source-text"],
      mode: "request",
      operation: "generate-speech",
      outputs: ["audio/mpeg"],
      required: ["source-text"],
    },
  ],
  text: [
    {
      delivery: "whole",
      inputs: ["direction", "source-text"],
      mode: "request",
      operation: "generate-text",
      outputs: ["text/markdown"],
      required: ["direction"],
    },
    {
      delivery: "whole",
      inputs: ["direction", "source-text"],
      mode: "request",
      operation: "reformat-text",
      outputs: ["text/markdown"],
      required: ["source-text"],
    },
  ],
  transcription: [
    {
      delivery: "whole",
      inputs: ["source-audio"],
      mode: "request",
      operation: "transcribe",
      outputs: ["text/plain"],
      required: ["source-audio"],
    },
  ],
  video: [
    {
      delivery: "whole",
      inputs: ["direction"],
      mode: "request",
      operation: "generate-video",
      outputs: ["video/mp4"],
      required: ["direction"],
    },
  ],
};

export function operationsOf(
  def: ProviderModelDefinition
): readonly CapabilityFact[] {
  if (def.operations) {
    return def.operations;
  }
  return DERIVED_FACTS[def.kind] ?? [];
}

export function servesKind(provider: Provider, kind: ModelKind): boolean {
  return provider.models.some((m) => m.kind === kind);
}

export function vendorClient<TConfig, TClient>(
  config: TConfig,
  build: (config: TConfig) => TClient
): { readonly client: TClient; readonly config: TConfig } {
  return { client: build(config), config };
}
