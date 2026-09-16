import { EventEmitter } from "node:events";
import type {
  EmbeddingModelV4,
  Experimental_VideoModelV4,
  ImageModelV4,
  LanguageModelV4,
  SpeechModelV4,
  TranscriptionModelV4,
} from "@ai-sdk/provider";
import type { AgentModel, ModelLimits } from "@foundry/agents/agents/model";
import type { AuditActor } from "evlog";
import type { ModelCost } from "evlog/ai";
import { modelAudit } from "./audit";
import type { AgentConfigType } from "./config";
import { AgentConfig } from "./config";
import { modelErrors } from "./errors";
import type { LocalProviderSurface } from "./local/surface";
import { isLocalProvider } from "./local/surface";
import {
  beginInitLog,
  configureModelObservability,
  recordAudit,
  SYSTEM_ACTOR,
} from "./logger";
import type {
  ModelManagerCredentials,
  Provider,
  ProviderBinding,
} from "./provider";
import { operationsOf, resolveDefinition, servesKind } from "./provider";
import type {
  CapabilityFact,
  ModelLimits as CatalogLimits,
  InteractionMode,
  KindDefault,
  MediaModel,
  ModelKind,
  Offer,
  OperationName,
  ProviderModelDefinition,
  Selection,
} from "./types";

/** The provider that fills the on-device role. Airplane Mode routes here only. */
const LOCAL_ROLE = "local";

export type { ModelManagerCredentials } from "./provider";

/** Exact executor selected for one conversational turn. */
export interface TurnExecutorRef {
  readonly harness: string;
  readonly model: string;
  readonly provider: string;
}

/** Optional per-selection inputs for {@link ModelManager.model}. */
export interface ModelSelectionOptions {
  /** Forwarded to providers that run the turn in a native harness. */
  workingDirectory?: string;
}

/** Optional narrowing for {@link ModelManager.select}. */
export interface OperationSelectionOptions {
  /** Defaults to `request`. */
  mode?: InteractionMode;
  model?: string;
  provider?: string;
}

export interface ModelManagerOptions {
  /** Providers that follow the credential record; see {@link ModelManager.configure}. */
  bindings?: ProviderBinding[];
  /** Per-kind routing when a caller names no provider. */
  defaults?: Partial<Record<ModelKind, KindDefault>>;
  providers?: Provider[];
  settings?: AgentConfigType;
}

export interface BootstrapOptions {
  credentials?: Partial<ModelManagerCredentials>;
}

export class ModelManager {
  private readonly _providers = new Map<string, Provider>();
  private readonly _bindings = new Map<string, ProviderBinding>();
  private readonly _defaults = new Map<ModelKind, KindDefault>();
  private _offline = false;

  readonly events = new EventEmitter();
  readonly settings: AgentConfig;

  constructor(options: ModelManagerOptions = {}) {
    this.settings = new AgentConfig(options.settings);
    for (const provider of options.providers ?? []) {
      this.register(provider);
    }
    for (const binding of options.bindings ?? []) {
      this.bind(binding);
    }
    for (const [kind, entry] of Object.entries(options.defaults ?? {})) {
      this.setDefault(kind as ModelKind, entry);
    }
    this.applySettingsDefaults();
    this.settings.on("changed", (next, prev) => {
      if (next.defaults !== prev.defaults) {
        this.applySettingsDefaults();
      }
    });
  }

  /**
   * Apply credentials and route embeddings on-device when a host has
   * registered `local`. No provider is constructed here: hosts register the
   * providers and bindings they ship, and the on-device runtime lives behind
   * `@foundry/models/local`.
   */
  bootstrap(options: BootstrapOptions = {}): void {
    if (options.credentials) {
      this.configure(options.credentials);
    }
    if (this.has(LOCAL_ROLE) && !this._defaults.has("embedding")) {
      this.setDefault("embedding", { provider: LOCAL_ROLE });
    }
  }

  register(provider: Provider): void {
    this._providers.set(provider.id, provider);
    this.syncCosts();
  }

  /** Let a Provider follow the credential record on every {@link configure}. */
  bind(binding: ProviderBinding): void {
    this._bindings.set(binding.id, binding);
  }

  unregister(id: string): void {
    this._providers.delete(id);
  }

  has(id: string): boolean {
    return this._providers.has(id);
  }

  get(id: string): Provider {
    const provider = this._providers.get(id);
    if (!provider) {
      throw modelErrors.PROVIDER_NOT_REGISTERED({ provider: id });
    }
    return provider;
  }

  list(): Provider[] {
    return [...this._providers.values()];
  }

  /** The on-device provider, or `null` when none is registered as `local`. */
  get local(): LocalProviderSurface | null {
    const provider = this._providers.get(LOCAL_ROLE);
    return provider && isLocalProvider(provider) ? provider : null;
  }

  getDefault(kind: ModelKind): KindDefault | null {
    return this._defaults.get(kind) ?? null;
  }

  setDefault(kind: ModelKind, entry: KindDefault | null): void {
    if (entry === null) {
      this._defaults.delete(kind);
      return;
    }
    if (!this._providers.has(entry.provider)) {
      throw modelErrors.PROVIDER_NOT_REGISTERED({ provider: entry.provider });
    }
    this._defaults.set(kind, entry);
  }

  model(
    modelId?: string,
    providerId?: string,
    options?: ModelSelectionOptions
  ): AgentModel {
    const { provider, def } = this.resolve("text", providerId, modelId);
    const model = provider.languageModel(def.modelId, {
      workingDirectory: options?.workingDirectory,
    });
    return agentModel(model, {
      route: { harness: provider.harness, id: def.id, provider: provider.id },
      ...(def.limits ? { limits: windowLimits(def.limits) } : {}),
    });
  }

  embedding(modelId?: string, providerId?: string): EmbeddingModelV4 {
    const { provider, def } = this.resolve("embedding", providerId, modelId);
    if (!provider.embeddingModel) {
      throw unsupported(provider, "embedding models");
    }
    return provider.embeddingModel(def.modelId);
  }

  image(modelId?: string, providerId?: string): ImageModelV4 {
    const { provider, def } = this.resolve("image", providerId, modelId);
    if (!provider.imageModel) {
      throw unsupported(provider, "image models");
    }
    return provider.imageModel(def.modelId);
  }

  speech(modelId?: string, providerId?: string): SpeechModelV4 {
    const { provider, def } = this.resolve("speech", providerId, modelId);
    if (!provider.speechModel) {
      throw unsupported(provider, "speech models");
    }
    return provider.speechModel(def.modelId);
  }

  transcription(modelId?: string, providerId?: string): TranscriptionModelV4 {
    const { provider, def } = this.resolve(
      "transcription",
      providerId,
      modelId
    );
    if (!provider.transcriptionModel) {
      throw unsupported(provider, "transcription models");
    }
    return provider.transcriptionModel(def.modelId);
  }

  video(modelId?: string, providerId?: string): Experimental_VideoModelV4 {
    const { provider, def } = this.resolve("video", providerId, modelId);
    if (!provider.videoModel) {
      throw unsupported(provider, "video models");
    }
    return provider.videoModel(def.modelId);
  }

  /**
   * The media seam for one row. Both ids are explicit: there is no default per
   * media Operation, and an unknown id is refused rather than passed through.
   */
  media(modelId: string, providerId: string): MediaModel {
    const provider = this.get(providerId);
    const def = this.rowOf(provider, modelId);
    if (!provider.mediaModel) {
      throw unsupported(provider, "media models");
    }
    return provider.mediaModel(def.modelId);
  }

  /**
   * The Model to run one Operation on. Admission is by Capability fact, never
   * by Kind: a row without a fact for this Operation and mode is refused, and
   * an id the Provider does not carry is refused rather than passed through as
   * a wire id. Pure and repeatable for unchanged configuration.
   */
  select(
    operation: OperationName,
    options: OperationSelectionOptions = {}
  ): Selection {
    const mode = options.mode ?? "request";
    const provider = this.providerForOperation(operation, mode, options);
    const model = options.model
      ? this.rowOf(provider, options.model)
      : (this.defaultRowFor(provider, operation, mode, options) ??
        provider.models.find((m) => factFor(m, operation, mode)));
    if (!model) {
      throw capabilityUnsupported(provider, operation, mode);
    }
    const fact = factFor(model, operation, mode);
    if (!fact) {
      throw capabilityUnsupported(provider, operation, mode);
    }
    if (!provider.available) {
      // Offline, the cloud-credentials advice on NO_USABLE_PROVIDER is useless.
      if (this._offline) {
        throw modelErrors.AIRPLANE_LOCAL_UNAVAILABLE({
          kind: operation,
          reason: "the local provider reports itself unavailable",
        });
      }
      throw modelErrors.NO_USABLE_PROVIDER({ kind: operation });
    }
    return { fact, model, provider };
  }

  /**
   * Every registered Provider's rows bearing a matching fact, with Availability
   * read now. Registered-but-uncredentialed Providers stay listed as
   * unavailable; price and limits are passed through, absence included.
   */
  offers(operation?: OperationName): Offer[] {
    const rows: Offer[] = [];
    for (const provider of this._providers.values()) {
      for (const model of provider.models) {
        for (const fact of operationsOf(model)) {
          if (operation !== undefined && fact.operation !== operation) {
            continue;
          }
          rows.push({
            available: provider.available,
            fact,
            model,
            provider: provider.id,
          });
        }
      }
    }
    return rows;
  }

  /**
   * Resolve and validate the complete text-executor route without building a
   * model. The ids are canonical catalog ids, suitable for durable session
   * metadata and exact restart restoration.
   */
  resolveTextExecutor(
    modelId?: string,
    providerId?: string,
    harnessId?: string
  ): TurnExecutorRef {
    const { provider, def } = this.resolve("text", providerId, modelId);
    if (!provider.available) {
      throw modelErrors.NO_USABLE_PROVIDER({ kind: "text" });
    }
    if (harnessId !== undefined && harnessId !== provider.harness) {
      throw new Error(
        `[models] executor harness "${harnessId}" does not own provider "${provider.id}" (expected "${provider.harness}")`
      );
    }
    return Object.freeze({
      harness: provider.harness,
      model: def.id,
      provider: provider.id,
    });
  }

  /** The resolved text model's catalog limits, or `undefined` when unknown. */
  textLimits(modelId?: string, providerId?: string): ModelLimits | undefined {
    const limits = this.tryResolve("text", providerId, modelId)?.limits;
    return limits ? windowLimits(limits) : undefined;
  }

  /** Output vector size declared by the resolved embedding row, if any. */
  embeddingDimensions(
    modelId?: string,
    providerId?: string
  ): number | undefined {
    return this.tryResolve("embedding", providerId, modelId)?.dimensions;
  }

  /**
   * The provider a caller should default to for `kind` when it has no explicit
   * choice: the configured kind default when usable, else the first available
   * online provider serving the kind. On-device providers are excluded so a
   * cloud feature never silently downgrades. Under Airplane Mode the answer is
   * the local role when it serves the kind. `null` when nothing can serve.
   */
  defaultProviderFor(kind: ModelKind): string | null {
    if (this._offline) {
      const local = this.local;
      return local && servesKind(local, kind) ? local.id : null;
    }
    const usable = (p: Provider | undefined): p is Provider =>
      p !== undefined && p.available && !p.offline && servesKind(p, kind);
    const preferred = this._providers.get(
      this._defaults.get(kind)?.provider ?? ""
    );
    if (usable(preferred)) {
      return preferred.id;
    }
    for (const provider of this._providers.values()) {
      if (usable(provider)) {
        return provider.id;
      }
    }
    return null;
  }

  /**
   * Airplane Mode. When on, every kind resolves through the local role; a kind
   * it does not serve, or an explicit request for another provider, throws
   * before any provider is reached. Reversible; stored defaults are untouched.
   */
  setOfflineMode(enabled: boolean): void {
    this._offline = enabled;
    for (const provider of this._providers.values()) {
      provider.setOffline?.(enabled);
    }
  }

  get offlineMode(): boolean {
    return this._offline;
  }

  /**
   * Run every provider's discovery (failure-tolerant: the static floor keeps
   * serving), then refresh the observability cost map. Under Airplane Mode
   * nothing is discovered — discovery is a live call. Returns the catalogs
   * that discovery replaced, keyed by provider id, so a host can persist them.
   */
  async init(): Promise<Map<string, ProviderModelDefinition[]>> {
    const discovered = new Map<string, ProviderModelDefinition[]>();
    if (!this._offline) {
      await Promise.all(
        this.list().map(async (provider) => {
          if (!provider.discover) {
            return;
          }
          const log = beginInitLog(provider.id);
          try {
            const rows = await provider.discover();
            if (rows.length > 0) {
              provider.models = rows;
              discovered.set(provider.id, rows);
            }
            log.set({ models: provider.models.length, state: "ready" });
            log.end();
          } catch (err) {
            log.set({ models: provider.models.length, state: "error" });
            log.end(err);
          }
        })
      );
    }
    this.syncCosts();
    this.events.emit("catalog-changed");
    return discovered;
  }

  /** Release every provider's external resources; one failure strands none. */
  async dispose(): Promise<void> {
    await Promise.allSettled(
      this.list().map((provider) => provider.dispose?.() ?? Promise.resolve())
    );
  }

  /**
   * Walk every binding with one credential record: a config registers or
   * updates its Provider, `null` unregisters it. Idempotent; only the
   * Providers this call touched are audited.
   */
  configure(
    credentials: Partial<ModelManagerCredentials>,
    options: { actor?: AuditActor } = {}
  ): void {
    const configured: string[] = [];

    for (const binding of this._bindings.values()) {
      const config = binding.fromCredentials(credentials);
      if (config !== null) {
        if (this.has(binding.id)) {
          binding.update(this.get(binding.id), config);
        } else {
          this.register(binding.create(config));
        }
      } else if (this.has(binding.id)) {
        binding.clear?.(this.get(binding.id));
        this.unregister(binding.id);
      } else {
        continue;
      }
      configured.push(binding.id);
    }

    for (const provider of configured) {
      recordAudit(
        modelAudit.PROVIDER_CONFIGURE({
          actor: options.actor ?? SYSTEM_ACTOR,
          reason: "credentials applied",
          target: { id: provider },
        })
      );
    }
    this.syncCosts();
  }

  /**
   * Routing order: explicit provider → the kind's default → the first usable
   * provider for the kind. Under Airplane Mode only the local role answers.
   */
  private resolve(
    kind: ModelKind,
    providerId: string | undefined,
    modelId: string | undefined
  ): { provider: Provider; def: ProviderModelDefinition } {
    if (this._offline) {
      const provider = this.airplaneProviderFor(kind, providerId);
      return { def: resolveDefinition(provider, kind, modelId), provider };
    }
    const kindDefault = providerId ? undefined : this._defaults.get(kind);
    const id =
      providerId ?? kindDefault?.provider ?? this.defaultProviderFor(kind);
    if (!id) {
      throw modelErrors.NO_USABLE_PROVIDER({ kind });
    }
    const provider = this.get(id);
    return {
      def: resolveDefinition(provider, kind, modelId ?? kindDefault?.modelId),
      provider,
    };
  }

  private tryResolve(
    kind: ModelKind,
    providerId: string | undefined,
    modelId: string | undefined
  ): ProviderModelDefinition | undefined {
    try {
      return this.resolve(kind, providerId, modelId).def;
    } catch {
      return undefined;
    }
  }

  /**
   * Explicit provider → Airplane Mode's local role → the first available,
   * online Provider carrying a row with the fact. Kind orders candidates that
   * already bear the fact; it never admits one that does not.
   */
  private providerForOperation(
    operation: OperationName,
    mode: InteractionMode,
    options: OperationSelectionOptions
  ): Provider {
    if (this._offline) {
      return this.localRole(operation, options.provider);
    }
    if (options.provider !== undefined) {
      return this.get(options.provider);
    }
    const bears = (def: ProviderModelDefinition) =>
      (options.model === undefined || def.id === options.model) &&
      factFor(def, operation, mode) !== undefined;
    const candidates = [...this._providers.values()].filter(
      (p) => p.available && !p.offline && p.models.some(bears)
    );
    const preferred = candidates.find((p) =>
      p.models.some(
        (def) =>
          bears(def) &&
          this._defaults.get(def.kind ?? "text")?.provider === p.id
      )
    );
    const chosen = preferred ?? candidates[0];
    if (!chosen) {
      throw modelErrors.NO_USABLE_PROVIDER({ kind: operation });
    }
    return chosen;
  }

  /**
   * The row a configured Kind default names, read through the same layers
   * `resolve` consults — `KindDefault.modelId`, then the Provider's own
   * `defaults[kind]` — and gated the same way, so a caller who named a
   * Provider, or Airplane Mode, sees the manager layer no more than `resolve`
   * does. Only rows already bearing the fact are considered: a default set for
   * a Kind was never a promise about an Operation, so one that bears no fact
   * here falls through rather than refusing an Operation the Provider serves.
   */
  private defaultRowFor(
    provider: Provider,
    operation: OperationName,
    mode: InteractionMode,
    options: OperationSelectionOptions
  ): ProviderModelDefinition | undefined {
    const skipKindDefault = options.provider !== undefined || this._offline;
    return provider.models.find((row) => {
      if (!factFor(row, operation, mode)) {
        return false;
      }
      const kind = row.kind ?? "text";
      const configured = skipKindDefault ? undefined : this._defaults.get(kind);
      const preferred =
        (configured?.provider === provider.id
          ? configured.modelId
          : undefined) ?? provider.defaults?.[kind];
      return preferred === row.id;
    });
  }

  /**
   * The local role under Airplane Mode, refusing before any provider is
   * reached. `subject` names what was asked for — a Kind or an Operation.
   */
  private localRole(
    subject: string,
    providerId: string | undefined
  ): LocalProviderSurface {
    if (providerId !== undefined && providerId !== LOCAL_ROLE) {
      throw modelErrors.AIRPLANE_LOCAL_UNAVAILABLE({
        kind: subject,
        reason: `provider "${providerId}" was requested explicitly`,
      });
    }
    const local = this.local;
    if (!local) {
      throw modelErrors.AIRPLANE_LOCAL_UNAVAILABLE({
        kind: subject,
        reason: "no provider is registered for the local role",
      });
    }
    return local;
  }

  private airplaneProviderFor(
    kind: ModelKind,
    providerId: string | undefined
  ): Provider {
    const local = this.localRole(kind, providerId);
    if (!servesKind(local, kind)) {
      throw modelErrors.AIRPLANE_LOCAL_UNAVAILABLE({
        kind,
        reason: "the local provider has no model of this kind",
      });
    }
    return local;
  }

  /** The Provider's row for this id, refused rather than passed through. */
  private rowOf(provider: Provider, modelId: string): ProviderModelDefinition {
    const def = provider.models.find((m) => m.id === modelId);
    if (!def) {
      throw modelErrors.MODEL_NOT_REGISTERED({
        model: modelId,
        provider: provider.id,
      });
    }
    return def;
  }

  /** Feed catalog list prices to the observability cost map. */
  private syncCosts(): void {
    const cost: Record<string, ModelCost> = {};
    for (const provider of this._providers.values()) {
      for (const def of provider.models) {
        if (def.costs) {
          cost[def.modelId] = {
            input: def.costs.input,
            output: def.costs.output,
          };
        }
      }
    }
    if (Object.keys(cost).length > 0) {
      configureModelObservability({ cost });
    }
  }

  /** Mirror `settings.defaults` onto routing; entries naming an unregistered provider wait for it. */
  private applySettingsDefaults(): void {
    const defaults = this.settings.get("defaults");
    if (!defaults) {
      return;
    }
    for (const [kind, entry] of Object.entries(defaults)) {
      if (this.has(entry.provider)) {
        this.setDefault(kind as ModelKind, entry);
      }
    }
  }
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

function unsupported(provider: Provider, capability: string) {
  return modelErrors.CAPABILITY_UNSUPPORTED({
    capability,
    provider: provider.id,
  });
}

function capabilityUnsupported(
  provider: Provider,
  operation: OperationName,
  mode: InteractionMode
) {
  return unsupported(provider, `the ${operation} Operation in ${mode} mode`);
}

/** The row's first fact for this Operation and mode, if it bears one. */
function factFor(
  def: ProviderModelDefinition,
  operation: OperationName,
  mode: InteractionMode
): CapabilityFact | undefined {
  return operationsOf(def).find(
    (fact) => fact.operation === operation && fact.mode === mode
  );
}
