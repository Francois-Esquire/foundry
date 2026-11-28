import type {
  EmbeddingModelV4,
  ImageModelV4,
  LanguageModelV4,
} from "@ai-sdk/provider";
import type { AgentModel, ModelLimits } from "@foundry/core/agents";
import { modelErrors } from "./errors";
import type {
  ModelLimits as CatalogLimits,
  ModelKind,
  ProviderModelDefinition,
} from "./model-definition";
import type { Provider, TurnLimit } from "./provider";
import type { Route } from "./selection";

export interface KindModels {
  embedding: EmbeddingModelV4;
  image: ImageModelV4;
  text: AgentModel;
}

export interface OpenOptions {
  text: {
    readonly nativeMaxTurns?: number;
    readonly workingDirectory?: string;
  };
}

type OpenArgs<K extends ModelKind> = K extends keyof OpenOptions
  ? [OpenOptions[K]?]
  : [];

export interface Resolution<K extends ModelKind = ModelKind> {
  readonly definition: ProviderModelDefinition;
  hold(): void;
  readonly kind: K;
  readonly model: string;
  open(...options: OpenArgs<K>): KindModels[K];
  readonly provider: string;
  release(): void;
  readonly route: Route;
  readonly turnLimit: TurnLimit;
  [Symbol.dispose](): void;
}

export interface Host {
  give(provider: Provider): void;
  take(provider: Provider): boolean;
}

export function resolution<K extends ModelKind>(
  leases: Host,
  kind: K,
  provider: Provider,
  definition: ProviderModelDefinition
): Resolution<K> {
  let held = false;
  const turnLimit = provider.turnLimit ?? "steps";
  const route: Route = { model: definition.id, provider: provider.id };
  const hold = () => {
    if (held) {
      return;
    }
    if (!leases.take(provider)) {
      throw modelErrors.ROUTE_STALE(route);
    }
    held = true;
  };
  const release = () => {
    if (held) {
      held = false;
      leases.give(provider);
    }
  };
  return {
    definition,
    hold,
    kind,
    model: definition.id,
    open: (...args) => {
      const options = args[0] as OpenOptions["text"] | undefined;
      if (options?.nativeMaxTurns !== undefined && turnLimit !== "native") {
        throw modelErrors.CAPABILITY_UNSUPPORTED({
          capability: "a native turn limit",
          provider: provider.id,
        });
      }
      const wasHeld = held;
      hold();
      try {
        return build(kind, provider, definition, options);
      } catch (error) {
        if (!wasHeld) {
          release();
        }
        throw error;
      }
    },
    provider: provider.id,
    release,
    route,
    [Symbol.dispose]: release,
    turnLimit,
  };
}

function build<K extends ModelKind>(
  kind: K,
  provider: Provider,
  definition: ProviderModelDefinition,
  options: OpenOptions["text"] | undefined
): KindModels[K] {
  const { modelId } = definition;
  const missing = (capability: string) =>
    modelErrors.CAPABILITY_UNSUPPORTED({ capability, provider: provider.id });
  const models: { [Kind in ModelKind]: () => KindModels[Kind] } = {
    embedding: () => {
      if (!provider.embeddingModel) {
        throw missing("embedding models");
      }
      return provider.embeddingModel(modelId);
    },
    image: () => {
      if (!provider.imageModel) {
        throw missing("image models");
      }
      return provider.imageModel(modelId);
    },
    text: () =>
      agentModel(
        provider.languageModel(modelId, {
          ...(options?.nativeMaxTurns === undefined
            ? {}
            : { nativeMaxTurns: options.nativeMaxTurns }),
          ...(options?.workingDirectory === undefined
            ? {}
            : { workingDirectory: options.workingDirectory }),
        }),
        {
          route: { id: definition.id, provider: provider.id },
          ...(definition.limits
            ? { limits: windowLimits(definition.limits) }
            : {}),
        }
      ),
  };
  return models[kind]();
}

function windowLimits(limits: CatalogLimits): ModelLimits {
  return {
    ...(limits.maxInputTokens === undefined
      ? {}
      : { contextWindow: limits.maxInputTokens }),
    ...(limits.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: limits.maxOutputTokens }),
  };
}

function agentModel(
  model: LanguageModelV4,
  facts: Pick<AgentModel, "route" | "limits">
): AgentModel {
  return {
    doGenerate: (options) => model.doGenerate(options),
    doStream: (options) => model.doStream(options),
    modelId: model.modelId,
    provider: model.provider,
    specificationVersion: model.specificationVersion,
    get supportedUrls() {
      return model.supportedUrls;
    },
    ...facts,
  };
}
