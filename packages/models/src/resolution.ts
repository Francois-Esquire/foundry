import type {
  EmbeddingModelV4,
  Experimental_VideoModelV4,
  ImageModelV4,
  LanguageModelV4,
  SpeechModelV4,
  TranscriptionModelV4,
} from "@ai-sdk/provider";
import type { AgentModel, ModelLimits } from "@foundry/agents/agents/model";
import { modelErrors } from "./errors";
import type { Provider, TurnLimit } from "./provider";
import type { Route } from "./selection";
import type {
  ModelLimits as CatalogLimits,
  MediaModel,
  ModelKind,
  ProviderModelDefinition,
} from "./types";

export interface KindModels {
  embedding: EmbeddingModelV4;
  image: ImageModelV4;
  music: MediaModel;
  segmentation: MediaModel;
  sound: MediaModel;
  speech: SpeechModelV4;
  text: AgentModel;
  transcription: TranscriptionModelV4;
  video: Experimental_VideoModelV4;
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
  check(): void;
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
  admit(provider: Provider): void;
  give(provider: Provider): void;
  take(provider: Provider): boolean;
  track(provider: Provider, call: AbortController): () => void;
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
    leases.admit(provider);
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
    check: () => leases.admit(provider),
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
        return build(kind, guarded(leases, provider), definition, options);
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
    music: () => media(provider, modelId, missing),
    segmentation: () => media(provider, modelId, missing),
    sound: () => media(provider, modelId, missing),
    speech: () => {
      if (!provider.speechModel) {
        throw missing("speech models");
      }
      return provider.speechModel(modelId);
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
    transcription: () => {
      if (!provider.transcriptionModel) {
        throw missing("transcription models");
      }
      return provider.transcriptionModel(modelId);
    },
    video: () => {
      if (!provider.videoModel) {
        throw missing("video models");
      }
      return provider.videoModel(modelId);
    },
  };
  return models[kind]();
}

function media(
  provider: Provider,
  modelId: string,
  missing: (capability: string) => Error
): MediaModel {
  if (!provider.mediaModel) {
    throw missing("media models");
  }
  return provider.mediaModel(modelId);
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

const SIGNALS: Readonly<Record<string, { index: number; key: string }>> = {
  doEmbed: { index: 0, key: "abortSignal" },
  doGenerate: { index: 0, key: "abortSignal" },
  doStart: { index: 0, key: "abortSignal" },
  doStatus: { index: 0, key: "abortSignal" },
  doStream: { index: 0, key: "abortSignal" },
  run: { index: 1, key: "signal" },
};

const instances = new WeakMap<object, Provider>();

export function instanceOf(provider: Provider): Provider {
  return instances.get(provider) ?? provider;
}

function view<T extends object>(
  target: T,
  wrap: (
    name: string | symbol,
    method: (...args: unknown[]) => unknown
  ) => unknown
): T {
  const wrapped = new Map<string | symbol, unknown>();
  const shell = Object.create(null) as T;
  return new Proxy(shell, {
    get: (_, name) => {
      const value = Reflect.get(target, name, target);
      if (typeof value !== "function") {
        return value;
      }
      if (!wrapped.has(name)) {
        wrapped.set(name, wrap(name, value as (...args: unknown[]) => unknown));
      }
      return wrapped.get(name);
    },
    getOwnPropertyDescriptor: (_, name) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, name);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(target),
    has: (_, name) => Reflect.has(target, name),
    ownKeys: () => Reflect.ownKeys(target),
    set: (_, name, value) => Reflect.set(target, name, value, target),
  });
}

export function guarded(host: Host, provider: Provider): Provider {
  const guard = <M extends object>(model: M): M =>
    view(
      model,
      (name, method) =>
        (...args: unknown[]) =>
          call(host, provider, String(name), method, args, (next) =>
            Reflect.apply(method, model, next)
          )
    );
  const guardedProvider = view(provider, (name, method) => {
    if (String(name).endsWith("Model")) {
      return (...args: unknown[]) =>
        guard(Reflect.apply(method, provider, args) as object);
    }
    if (name === "grant") {
      return (...args: unknown[]) =>
        call(host, provider, "grant", method, args, (next) =>
          Reflect.apply(method, provider, next)
        );
    }
    return method.bind(provider);
  });
  instances.set(guardedProvider, provider);
  return guardedProvider;
}

function call(
  host: Host,
  provider: Provider,
  name: string,
  method: (...args: unknown[]) => unknown,
  args: unknown[],
  run: (args: unknown[]) => unknown
): unknown {
  try {
    host.admit(provider);
  } catch (error) {
    if (name in SIGNALS || method.constructor.name === "AsyncFunction") {
      return Promise.reject(error);
    }
    throw error;
  }
  const controller = new AbortController();
  const result = run(withSignal(name, args, controller.signal));
  if (!isPromise(result)) {
    return result;
  }
  const untrack = host.track(provider, controller);
  const refused = refusedBy(controller.signal);
  return Promise.race([result, refused]).then(
    (value) => {
      if (name === "doStream" && isStreamed(value)) {
        return { ...value, stream: cut(value.stream, controller, untrack) };
      }
      untrack();
      return value;
    },
    (error: unknown) => {
      untrack();
      throw error;
    }
  );
}

function isPromise(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isStreamed(
  value: unknown
): value is { stream: ReadableStream<unknown> } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { stream?: unknown }).stream instanceof ReadableStream
  );
}

function refusedBy(signal: AbortSignal): Promise<never> {
  const refused = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
  refused.catch(() => undefined);
  return refused;
}

function withSignal(
  name: string,
  args: unknown[],
  signal: AbortSignal
): unknown[] {
  const place = SIGNALS[name];
  if (!place) {
    return args;
  }
  const options = (args[place.index] ?? {}) as Record<string, unknown>;
  const own = options[place.key] as AbortSignal | undefined;
  const next = [...args];
  next[place.index] = {
    ...options,
    [place.key]: own ? AbortSignal.any([own, signal]) : signal,
  };
  return next;
}

function cut<T>(
  stream: ReadableStream<T>,
  controller: AbortController,
  untrack: () => void
): ReadableStream<T> {
  const reader = stream.getReader();
  const refused = refusedBy(controller.signal);
  const stop = (out: ReadableStreamDefaultController<T>, error: unknown) => {
    untrack();
    reader.cancel(error).catch(() => undefined);
    out.error(error);
  };
  return new ReadableStream<T>(
    {
      cancel: async (reason) => {
        untrack();
        await reader.cancel(reason);
      },
      pull: async (out) => {
        if (controller.signal.aborted) {
          stop(out, controller.signal.reason);
          return;
        }
        try {
          const chunk = await Promise.race([reader.read(), refused]);
          if (controller.signal.aborted) {
            stop(out, controller.signal.reason);
            return;
          }
          if (chunk.done) {
            untrack();
            out.close();
            return;
          }
          out.enqueue(chunk.value);
        } catch (error) {
          stop(out, error);
        }
      },
      start: (out) => {
        controller.signal.addEventListener(
          "abort",
          () => stop(out, controller.signal.reason),
          { once: true }
        );
      },
    },
    { highWaterMark: 0 }
  );
}
