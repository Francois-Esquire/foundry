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

/** Per-call inputs a provider may need when it constructs a language model. */
export interface LanguageModelOptions {
  /**
   * Turn-scoped working directory for providers that execute through a native
   * agent harness (Claude Code, Codex). API providers ignore it.
   */
  workingDirectory?: string;
}

/** The credential record hosts hand to {@link ProviderBinding.fromCredentials}. */
export interface ModelManagerCredentials {
  aiGatewayApiKey?: string | null;
  aiGatewayUrl?: string | null;
  falApiKey?: string | null;
  /** Catalog to give the gateway provider when it is registered. */
  gatewayModels?: ProviderModelDefinition[];
  replicateApiToken?: string | null;
  vercelApiKey?: string | null;
}

/**
 * How one Provider follows the credential record. A host registers the
 * bindings it ships and `ModelManager.configure` walks them: a config
 * registers or updates the Provider, `null` unregisters it. The manager
 * itself names no provider.
 */
export interface ProviderBinding<TInput = unknown> {
  /** Runs before an unregister, so no configured vendor client is left behind. */
  clear?(provider: Provider): void;
  create(input: TInput): Provider;
  fromCredentials(credentials: Partial<ModelManagerCredentials>): TInput | null;
  readonly id: string;
  update(provider: Provider, input: TInput): void;
}

/**
 * The provider contract: an AI SDK provider plus the facts the registry needs
 * to route, list, and price its models. Plain objects satisfy it; the built-in
 * factories return one, and the on-device class implements it.
 *
 * Model methods take the **wire** id (`ProviderModelDefinition.modelId`) —
 * the same convention as the AI SDK's `ProviderV4`. Catalog-id resolution is
 * the manager's job; see {@link resolveDefinition}.
 */
export interface Provider<TConfig extends object = Record<string, unknown>> {
  /** Credentialed / installed / switched on — whatever "usable" means here. */
  readonly available: boolean;

  /** Apply a config patch (credentials, availability, binary path). */
  configure?(patch: Partial<TConfig>): void;
  /** Catalog id to prefer per kind when the caller names none. */
  readonly defaults?: Partial<Record<ModelKind, string>>;
  /** Ask upstream for the live model list. Replaces {@link models} wholesale. */
  discover?(): Promise<ProviderModelDefinition[]>;
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
  /**
   * Who runs a turn on this provider's models. Network providers sit behind
   * Studio's in-app harness; a CLI harness serves only its own models and
   * names itself. Many-to-one over providers, which is why it is not `id`.
   */
  readonly harness: string;
  readonly id: string;
  imageModel?(modelId: string): ImageModelV4;

  languageModel(
    modelId: string,
    options?: LanguageModelOptions
  ): LanguageModelV4;
  /** Operations the AI SDK has no model kind for; vendor JSON stops here. */
  mediaModel?(modelId: string): MediaModel;
  /** The current catalog: the static floor until {@link discover} replaces it. */
  models: ProviderModelDefinition[];
  /** Can serve without network once any required weights are present. */
  readonly offline: boolean;
  /** Airplane Mode toggled; stop (or resume) reaching the network. */
  setOffline?(offline: boolean): void;
  speechModel?(modelId: string): SpeechModelV4;
  transcriptionModel?(modelId: string): TranscriptionModelV4;
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
 * Resolve a catalog row for `kind`. Order: explicit id (kind-checked) →
 * provider default for the kind → first row of the kind. An id the catalog
 * does not know is passed through as the wire id: upstream lists move faster
 * than any floor here, so an unseen id is a request, not an error.
 */
export function resolveDefinition(
  provider: Provider,
  kind: ModelKind,
  id?: string
): ProviderModelDefinition {
  const kindOf = (def: ProviderModelDefinition) => def.kind ?? "text";
  if (id) {
    const found = provider.models.find((m) => m.id === id);
    if (!found) {
      return { id, kind, modelId: id };
    }
    if (kindOf(found) !== kind) {
      throw modelErrors.MODEL_KIND_MISMATCH({
        actual: kindOf(found),
        expected: kind,
        model: found.id,
        provider: provider.id,
      });
    }
    return found;
  }
  const preferred = provider.defaults?.[kind];
  const dflt = preferred
    ? provider.models.find((m) => m.id === preferred)
    : undefined;
  if (dflt && kindOf(dflt) === kind) {
    return dflt;
  }
  const first = provider.models.find((m) => kindOf(m) === kind);
  if (!first) {
    throw modelErrors.NO_MODEL_OF_KIND({ kind, provider: provider.id });
  }
  return first;
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
  return DERIVED_FACTS[def.kind ?? "text"] ?? [];
}

export function servesKind(provider: Provider, kind: ModelKind): boolean {
  return provider.models.some((m) => (m.kind ?? "text") === kind);
}
