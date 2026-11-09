import type {
  EmbeddingModelV4,
  Experimental_VideoModelV4,
  ImageModelV4,
  LanguageModelV4,
  ProviderV4,
  SpeechModelV4,
  TranscriptionModelV4,
} from "@ai-sdk/provider";
import { modelErrors } from "./errors";
import type { LiveAccess } from "./live/types";
import type {
  CapabilityFact,
  MediaModel,
  ModelKind,
  OperationName,
  ProviderModelDefinition,
} from "./types";

/**
 * How an instance enforces a turn limit: through its own native loop, by the
 * caller stopping after N steps, or not at all, because it runs its own loop
 * inside one call.
 */
export type TurnLimit = "native" | "steps" | "unsupported";

/** Per-call inputs a provider may need when it constructs a language model. */
export interface LanguageModelOptions {
  /** Native Claude Code loop limit; other native harnesses do not support it. */
  nativeMaxTurns?: number;
  /**
   * Turn-scoped working directory for providers that execute through a native
   * agent harness (Claude Code, Codex). API providers ignore it.
   */
  workingDirectory?: string;
}

/**
 * The provider contract: an AI SDK provider plus the facts the registry needs
 * to route, list, and price its models. Plain objects satisfy it; the built-in
 * factories return one, and the on-device class implements it.
 *
 * Model methods take the **wire** id (`ProviderModelDefinition.modelId`) —
 * the same convention as the AI SDK's `ProviderV4`. Catalog-id resolution is
 * the manager's job; see {@link catalogRow}.
 */
export interface Provider {
  /** Credentialed / installed / switched on — whatever "usable" means here. */
  readonly available: boolean;

  /** Catalog id to prefer per kind when the caller names none. */
  readonly defaults?: Partial<Record<ModelKind, string>>;
  /** Release anything held outside process memory (child processes, weights). */
  dispose?(): Promise<void>;
  embeddingModel?(modelId: string): EmbeddingModelV4;
  /**
   * Live access for a party outside this process, for one Operation on the
   * Model. Refuses when unavailable or when the row bears no live fact for it.
   * The result never carries the key.
   *
   * The exception to the wire-id convention above: `grant` takes the **catalog**
   * id, because it must find the row to read its live fact, and an id the
   * Provider does not carry is refused rather than passed through.
   */
  grant?(modelId: string, operation: OperationName): Promise<LiveAccess>;
  readonly id: string;
  imageModel?(modelId: string): ImageModelV4;

  languageModel(
    modelId: string,
    options?: LanguageModelOptions
  ): LanguageModelV4;
  /** Operations the AI SDK has no model kind for; vendor JSON stops here. */
  mediaModel?(modelId: string): MediaModel;
  /** The supplied catalog, fixed for the instance's life. */
  readonly models: readonly ProviderModelDefinition[];
  /** Can serve without network once any required weights are present. */
  readonly offline: boolean;
  /** Airplane Mode toggled; stop (or resume) reaching the network. */
  setOffline?(offline: boolean): void | Promise<void>;
  speechModel?(modelId: string): SpeechModelV4;
  transcriptionModel?(modelId: string): TranscriptionModelV4;
  /** How a turn limit is enforced. Absent means `"steps"`. */
  readonly turnLimit?: TurnLimit;
  videoModel?(modelId: string): Experimental_VideoModelV4;
}

/**
 * Adapt an AI SDK provider object into a {@link Provider}. The SDK object's
 * optional model kinds are forwarded only when it implements them, so a
 * missing kind throws `CAPABILITY_UNSUPPORTED` at the manager instead of
 * `undefined is not a function` inside the SDK.
 */
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
  // `ProviderV4` does not declare `videoModel`, but SDK provider objects ship
  // it ahead of the spec; declaring it optional here forwards it when present
  // without narrowing what a caller may pass.
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

/**
 * The row `id` names with `kind`, else the instance's default or first row of
 * `kind`. Strict: an id the catalog does not list with `kind` is refused.
 */
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

/**
 * Facts derived from a Kind for rows written before Capability facts existed.
 * `embedding`, `music`, `sound`, and `segmentation` derive nothing: those rows
 * must declare `operations` to be offered at all.
 */
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

/**
 * The Capability facts a row bears. Explicit `operations` wins; otherwise the
 * Kind derivation above answers. Pure, and never throws.
 */
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

/** A factory's config and the vendor client built from it, once per instance. */
export function vendorClient<TConfig, TClient>(
  config: TConfig,
  build: (config: TConfig) => TClient
): { readonly client: TClient; readonly config: TConfig } {
  return { client: build(config), config };
}
