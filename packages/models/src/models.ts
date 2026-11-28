import { TypedEmitter } from "@foundry/lib/emitter";
import { EvlogError } from "evlog";
import type { ModelCost } from "evlog/ai";
import { modelErrors } from "./errors";
import type { ModelKind, ProviderModelDefinition } from "./model-definition";
import { MODEL_KINDS } from "./model-definition";
import { configureModelObservability } from "./observability";
import type { Provider } from "./provider";
import { catalogRow, servesKind } from "./provider";
import type { Host, Resolution } from "./resolution";
import { resolution } from "./resolution";
import type { ModelSelection } from "./selection";

// biome-ignore lint/suspicious/noExplicitAny: Preserve EventEmitter compatibility for custom listener signatures.
export type ModelsEventListener<Args extends any[] = any[]> = (
  this: unknown,
  ...args: Args
) => void;

export class ModelsEventEmitter extends TypedEmitter {}

const UNRESOLVED = new Set<string>([
  modelErrors.MODEL_KIND_MISMATCH.code,
  modelErrors.MODEL_NOT_FOUND.code,
  modelErrors.NO_MODEL_OF_KIND.code,
  modelErrors.PROVIDER_NOT_CONFIGURED.code,
  modelErrors.PROVIDER_UNAVAILABLE.code,
  modelErrors.SELECTION_AMBIGUOUS.code,
]);

export interface ModelsOptions {
  providers?: readonly Provider[];
}

export class Models {
  private readonly _providers = new Map<string, Provider>();
  private readonly leaseCounts = new Map<Provider, number>();
  private readonly leaving = new Set<Provider>();
  private readonly disposing = new Set<Promise<void>>();
  private readonly leases: Host = {
    give: (provider: Provider) => {
      const count = (this.leaseCounts.get(provider) ?? 1) - 1;
      if (count > 0) {
        this.leaseCounts.set(provider, count);
        return;
      }
      this.leaseCounts.delete(provider);
      if (this.leaving.delete(provider)) {
        this.retire(provider);
      }
    },
    take: (provider: Provider) => {
      const count = this.leaseCounts.get(provider) ?? 0;
      if (count === 0 && this._providers.get(provider.id) !== provider) {
        return false;
      }
      this.leaseCounts.set(provider, count + 1);
      return true;
    },
  };

  readonly events = new ModelsEventEmitter();

  constructor(options: ModelsOptions = {}) {
    this.setProviders(options.providers ?? []);
  }

  get providers(): readonly Provider[] {
    return [...this._providers.values()];
  }

  setProviders(providers: readonly Provider[]): void {
    const ids = new Set(providers.map((provider) => provider.id));
    if (ids.size !== providers.length) {
      throw new Error("Each provider id may appear once in the set");
    }
    const staying = new Set(providers);
    for (const provider of this._providers.values()) {
      if (!staying.has(provider)) {
        this.leave(provider);
      }
    }
    this._providers.clear();
    for (const provider of providers) {
      this._providers.set(provider.id, provider);
      this.leaving.delete(provider);
    }
    this.syncCosts();
    this.events.emit("providers-changed");
  }

  resolve<K extends ModelKind>(
    kind: K,
    selection?: ModelSelection
  ): Resolution<K> {
    const { provider, definition } = this.find(kind, selection);
    return resolution(this.leases, kind, provider, definition);
  }

  available(selection: ModelSelection): boolean {
    return MODEL_KINDS.some((kind) => {
      try {
        this.find(kind, selection);
        return true;
      } catch (error) {
        if (
          EvlogError.isEvlogError(error) &&
          UNRESOLVED.has(error.code ?? "")
        ) {
          return false;
        }
        throw error;
      }
    });
  }

  async dispose(): Promise<void> {
    const remaining = new Set([...this._providers.values(), ...this.leaving]);
    this.leaving.clear();
    await Promise.allSettled([
      ...[...remaining].map(disposeOf),
      ...this.disposing,
    ]);
  }

  private find(kind: ModelKind, selection: ModelSelection | undefined): Match {
    if (typeof selection !== "string") {
      return this.findRoute(kind, selection?.provider, selection?.model);
    }
    const slash = selection.indexOf("/");
    const prefix = slash > 0 ? selection.slice(0, slash) : undefined;
    const qualified =
      prefix !== undefined && this._providers.has(prefix)
        ? { model: selection.slice(slash + 1), provider: prefix }
        : undefined;
    const bare = this.lists(kind, undefined, selection);
    if (qualified && this.lists(kind, qualified.provider, qualified.model)) {
      if (bare) {
        throw modelErrors.SELECTION_AMBIGUOUS({ selection });
      }
      return this.findRoute(kind, qualified.provider, qualified.model);
    }
    if (bare || !qualified) {
      return this.findRoute(kind, undefined, selection);
    }
    return this.findRoute(kind, qualified.provider, qualified.model);
  }

  private lists(
    kind: ModelKind,
    providerId: string | undefined,
    model: string
  ): boolean {
    const candidates =
      providerId === undefined
        ? [...this._providers.values()]
        : [this._providers.get(providerId)].filter(
            (provider): provider is Provider => provider !== undefined
          );
    return candidates.some((provider) =>
      provider.models.some((row) => row.id === model && row.kind === kind)
    );
  }

  private findRoute(
    kind: ModelKind,
    providerId: string | undefined,
    model: string | undefined
  ): Match {
    if (providerId !== undefined) {
      const provider = this._providers.get(providerId);
      if (!provider) {
        throw modelErrors.PROVIDER_NOT_CONFIGURED({ provider: providerId });
      }
      if (!provider.available) {
        throw modelErrors.PROVIDER_UNAVAILABLE({ kind, provider: provider.id });
      }
      return { definition: catalogRow(provider, kind, model), provider };
    }
    if (model !== undefined) {
      return this.firstListing(kind, model);
    }
    const serving = [...this._providers.values()].filter((candidate) =>
      servesKind(candidate, kind)
    );
    const provider = serving.find((candidate) => candidate.available);
    if (!provider) {
      if (serving.length === 0) {
        throw modelErrors.NO_MODEL_OF_KIND({ kind, provider: "any" });
      }
      throw modelErrors.PROVIDER_UNAVAILABLE({ kind });
    }
    return { definition: catalogRow(provider, kind), provider };
  }

  private firstListing(kind: ModelKind, model: string): Match {
    const skipped: string[] = [];
    let otherKind: ProviderModelDefinition | undefined;
    for (const provider of this._providers.values()) {
      const row = provider.models.find(
        (entry) => entry.id === model && entry.kind === kind
      );
      if (!row) {
        otherKind ??= provider.models.find((entry) => entry.id === model);
        continue;
      }
      if (!provider.available) {
        skipped.push(`${provider.id} (unavailable)`);
        continue;
      }
      return { definition: row, provider };
    }
    if (skipped.length === 0 && otherKind) {
      throw modelErrors.MODEL_KIND_MISMATCH({
        actual: otherKind.kind,
        expected: kind,
        model,
        provider:
          [...this._providers.values()].find((p) =>
            p.models.includes(otherKind as ProviderModelDefinition)
          )?.id ?? "unknown",
      });
    }
    throw modelErrors.MODEL_NOT_FOUND({
      model,
      searched: [...this._providers.keys()],
      ...(skipped.length > 0 ? { skipped: skipped.join(", ") } : {}),
    });
  }

  private leave(provider: Provider): void {
    if (this.leaseCounts.has(provider)) {
      this.leaving.add(provider);
    } else {
      this.retire(provider);
    }
  }

  private retire(provider: Provider): void {
    const disposal = disposeOf(provider)
      .catch((error: unknown) => {
        this.events.emit("dispose-failed", { error, provider: provider.id });
      })
      .finally(() => {
        this.disposing.delete(disposal);
        this.events.emit("provider-retired", provider);
      });
    this.disposing.add(disposal);
  }

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
}

interface Match {
  readonly definition: ProviderModelDefinition;
  readonly provider: Provider;
}

function disposeOf(provider: Provider): Promise<void> {
  try {
    return Promise.resolve(provider.dispose?.());
  } catch (error) {
    return Promise.reject(error);
  }
}
