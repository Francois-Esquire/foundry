import { EventEmitter } from "node:events";
import type { ModelCost } from "evlog/ai";
import { modelErrors } from "./errors";
import { configureModelObservability } from "./logger";
import type { Provider } from "./provider";
import { catalogRow, servesKind } from "./provider";
import type { Host, Resolution } from "./resolution";
import { guarded, instanceOf, resolution } from "./resolution";
import type { ModelSelection } from "./selection";
import type { ModelKind, ProviderModelDefinition } from "./types";

export interface ModelManagerOptions {
  providers?: readonly Provider[];
}

/** A rule a host installs on one manager; Airplane Mode is one. */
export interface ProviderPolicy {
  /** `true` admits; a string refuses, with that reason. Pure and fast. */
  admit(provider: Provider): true | string;
  readonly id: string;
}

/**
 * An ordered set of provider instances and one way to choose among them.
 * Order is preference. Resolving checks catalogs; opening leases the
 * instance, so a session keeps it after it leaves the set.
 */
export class ModelManager {
  private readonly _providers = new Map<string, Provider>();
  private readonly leaseCounts = new Map<Provider, number>();
  /** Left the set while leased; disposed after the last release. */
  private readonly leaving = new Set<Provider>();
  private readonly disposing = new Set<Promise<void>>();
  private readonly policies = new Map<string, ProviderPolicy>();
  private readonly calls = new Map<Provider, Set<AbortController>>();
  /** Each instance's guarded view, built once, so callers never hold an unguarded one. */
  private readonly views = new WeakMap<Provider, Provider>();
  private readonly leases: Host = {
    admit: (provider: Provider) => {
      const refusal = this.refusal(provider);
      if (refusal) {
        throw refusal;
      }
    },
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
    track: (provider: Provider, call: AbortController) => {
      const running = this.calls.get(provider) ?? new Set();
      running.add(call);
      this.calls.set(provider, running);
      return () => {
        running.delete(call);
        if (running.size === 0 && this.calls.get(provider) === running) {
          this.calls.delete(provider);
        }
      };
    },
  };

  /**
   * `providers-changed`, `policies-changed`, `provider-retired` with the
   * instance once it is disposed, `dispose-failed` with `{ error, provider }`,
   * and `offline-failed` from Airplane Mode.
   */
  readonly events = new EventEmitter();

  constructor(options: ModelManagerOptions = {}) {
    this.setProviders(options.providers ?? []);
  }

  /**
   * The configured instances, in preference order, each as a stable guarded
   * view: a model built or live access granted through one is checked like
   * any other. A provider is identified by its instance id; a view is not the
   * object the host supplied, and passes back into `setProviders` of any
   * manager as that instance.
   */
  get providers(): readonly Provider[] {
    return [...this._providers.values()].map((provider) => this.view(provider));
  }

  /**
   * Replace the whole ordered set. An instance that leaves is disposed now,
   * or after its last lease is released when a session still holds it.
   */
  setProviders(given: readonly Provider[]): void {
    const providers = given.map(instanceOf);
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
      // Back in the set before its last lease ended: it is no longer leaving.
      this.leaving.delete(provider);
    }
    this.syncCosts();
    this.events.emit("providers-changed");
  }

  /**
   * One catalog-checked route for `kind`. A provider and model are both
   * checked; a model alone goes to the first provider in order that lists it;
   * a provider alone uses its default for the kind; nothing picks the first
   * available provider serving the kind. A string holding `/` is read both
   * as `provider/model` and as a model id, and must match exactly one way.
   */
  resolve<K extends ModelKind>(
    kind: K,
    selection?: ModelSelection
  ): Resolution<K> {
    const { provider, definition } = this.find(kind, selection);
    return resolution(this.leases, kind, provider, definition);
  }

  /**
   * Install a policy. New resolutions, opens, holds, checks, and every call
   * on a model already opened consult it, and calls in flight on an instance
   * it refuses are aborted. Returns the remover.
   */
  restrict(policy: ProviderPolicy): () => void {
    if (this.policies.has(policy.id)) {
      throw new Error(`A policy "${policy.id}" is already installed`);
    }
    this.policies.set(policy.id, policy);
    this.abortRefused();
    this.events.emit("policies-changed");
    return () => {
      if (this.policies.get(policy.id) === policy) {
        this.policies.delete(policy.id);
        this.events.emit("policies-changed");
      }
    };
  }

  /** Release every instance, including leased ones that left; one failure strands none. */
  async dispose(): Promise<void> {
    const remaining = new Set([...this._providers.values(), ...this.leaving]);
    this.leaving.clear();
    await Promise.allSettled([
      ...[...remaining].map(disposeOf),
      ...this.disposing,
    ]);
  }

  /** Resolve one selection to an instance and catalog row; see {@link resolve}. */
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

  /** Whether a catalog lists `model` with `kind`; availability is not consulted. */
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
      this.leases.admit(provider);
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
    const provider = serving.find(
      (candidate) => candidate.available && !this.refusal(candidate)
    );
    if (!provider) {
      if (serving.length === 0) {
        throw modelErrors.NO_MODEL_OF_KIND({ kind, provider: "any" });
      }
      // An instance that could serve but a policy refuses explains more than "unavailable".
      const refused = serving.find((candidate) => candidate.available);
      throw (
        (refused && this.refusal(refused)) ??
        modelErrors.PROVIDER_UNAVAILABLE({ kind })
      );
    }
    return { definition: catalogRow(provider, kind), provider };
  }

  /** The first instance in order whose catalog lists `model` with `kind`. */
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
      const refusal = this.refusal(provider);
      if (refusal) {
        skipped.push(`${provider.id} (${refusal.message})`);
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

  private view(provider: Provider): Provider {
    let view = this.views.get(provider);
    if (!view) {
      view = guarded(this.leases, provider);
      this.views.set(provider, view);
    }
    return view;
  }

  /** The error the first refusing policy gives, or undefined when all admit. */
  private refusal(provider: Provider): Error | undefined {
    for (const policy of this.policies.values()) {
      const verdict = policy.admit(provider);
      if (verdict !== true) {
        return modelErrors.PROVIDER_RESTRICTED({
          policy: policy.id,
          provider: provider.id,
          reason: verdict,
        });
      }
    }
    return undefined;
  }

  private abortRefused(): void {
    for (const [provider, running] of this.calls) {
      const refusal = this.refusal(provider);
      if (refusal) {
        for (const call of running) {
          call.abort(refusal);
        }
      }
    }
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
        this.events.emit("provider-retired", this.view(provider));
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

/** An instance's disposal as a promise, even when `dispose` throws synchronously. */
function disposeOf(provider: Provider): Promise<void> {
  try {
    return Promise.resolve(provider.dispose?.());
  } catch (error) {
    return Promise.reject(error);
  }
}
