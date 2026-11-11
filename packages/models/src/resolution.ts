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

/** What `open()` builds for each kind. */
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
    /** Only when the route's `turnLimit` is `"native"`. */
    readonly nativeMaxTurns?: number;
    readonly workingDirectory?: string;
  };
}

type OpenArgs<K extends ModelKind> = K extends keyof OpenOptions
  ? [OpenOptions[K]?]
  : [];

/**
 * A catalog-checked route bound to the instance that matched it. Resolving
 * holds nothing; `open` and `hold` lease the instance until `release`, so a
 * session keeps it even after it leaves the provider set.
 */
export interface Resolution<K extends ModelKind = ModelKind> {
  /** Throws `PROVIDER_RESTRICTED` when a policy now refuses the instance. */
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

/** What a resolution needs from its manager: leases, policies, and calls in flight. */
export interface Host {
  /** Throws `PROVIDER_RESTRICTED` when a policy refuses the instance. */
  admit(provider: Provider): void;
  give(provider: Provider): void;
  /** False when the instance left the set and nothing leases it. */
  take(provider: Provider): boolean;
  /** Abort `call` if a policy change refuses the instance; returns the untracker. */
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

/** The catalog's token limits in the window vocabulary an agent sizes by. */
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

/**
 * The SDK model plus what the agent reads off it. Delegates rather than
 * mutating: the provider's instance stays its own, and its methods keep
 * running on it.
 */
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

/** Where each call that takes one carries its abort signal. */
const SIGNALS: Readonly<Record<string, { index: number; key: string }>> = {
  doEmbed: { index: 0, key: "abortSignal" },
  doGenerate: { index: 0, key: "abortSignal" },
  doStart: { index: 0, key: "abortSignal" },
  doStatus: { index: 0, key: "abortSignal" },
  doStream: { index: 0, key: "abortSignal" },
  run: { index: 1, key: "signal" },
};

/** Every guarded view, to the instance behind it, across all managers. */
const instances = new WeakMap<object, Provider>();

/** The instance behind a guarded view, or the argument itself. */
export function instanceOf(provider: Provider): Provider {
  return instances.get(provider) ?? provider;
}

/**
 * A view of `target` that reads through to it, so getters and `#private`
 * fields work, and replaces each method with `wrap(name, method)`, built once
 * per name. The view is a proxy over an empty shell, never over `target`, so
 * a frozen target or a non-configurable method cannot break proxy invariants.
 */
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

/**
 * `provider` behind the policy guard: every method on every model it builds,
 * and live access it grants, is admitted by the manager's policies first,
 * and cut if a policy refuses it while pending. `grant` takes no signal, so a
 * cut grant may still be minted upstream; its caller never receives it.
 */
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

/**
 * One admitted call. A call that returns a promise is tracked while it runs,
 * gets a signal linked to the caller's, and is cut when a policy change
 * refuses the instance, whether or not the provider honors the signal.
 */
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
    // A method known to answer with a promise refuses with a rejected one.
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

/** Rejects with the abort reason once `signal` aborts; never resolves. */
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

/** The call's arguments with `signal` linked into its abort signal. */
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

/**
 * `stream`, errored the moment `controller` aborts, so no chunk is delivered
 * after a refusal, buffered or not, and untracked once it settles.
 */
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
