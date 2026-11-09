import type { ModelManager, ProviderPolicy } from "./manager";
import type { Provider } from "./provider";

export interface AirplaneMode {
  /** Lift the policy and bring instances back online. */
  dispose(): void;
  readonly enabled: boolean;
  set(enabled: boolean): void;
}

const POLICY: ProviderPolicy = {
  admit: (provider) =>
    provider.offline ||
    "Airplane Mode admits only providers that serve offline",
  id: "airplane",
};

/**
 * Airplane Mode for one manager: off when created, never persisted. Turning
 * it on installs the policy before anything else, so a failure afterwards
 * leaves it refusing; then each instance, including ones added later, is told
 * to stop what outlives a call. A failure to do so is reported as
 * `offline-failed` on the manager, or as a process warning when nobody listens.
 */
export function airplaneMode(models: ModelManager): AirplaneMode {
  let lift: (() => void) | undefined;
  const offline = new Set<Provider>();

  const tell = (provider: Provider, value: boolean) => {
    const failed = (error: unknown) => {
      const heard = models.events.emit("offline-failed", {
        error,
        offline: value,
        provider: provider.id,
      });
      if (!heard) {
        process.emitWarning(
          `Provider "${provider.id}" failed to go ${value ? "offline" : "online"}: ${String(error)}`,
          { code: "FOUNDRY_MODELS_OFFLINE_FAILED" }
        );
      }
    };
    try {
      Promise.resolve(provider.setOffline?.(value)).catch(failed);
    } catch (error) {
      failed(error);
    }
  };

  // Kept until disposed, so an instance a session still holds comes back online too.
  const retired = (provider: Provider) => {
    offline.delete(provider);
  };

  const joined = () => {
    for (const provider of models.providers) {
      if (!offline.has(provider)) {
        offline.add(provider);
        tell(provider, true);
      }
    }
  };

  const set = (enabled: boolean) => {
    if (enabled === (lift !== undefined)) {
      return;
    }
    if (enabled) {
      lift = models.restrict(POLICY);
      models.events.on("providers-changed", joined);
      models.events.on("provider-retired", retired);
      joined();
      return;
    }
    models.events.off("providers-changed", joined);
    models.events.off("provider-retired", retired);
    lift?.();
    lift = undefined;
    for (const provider of offline) {
      tell(provider, false);
    }
    offline.clear();
  };

  return {
    dispose: () => set(false),
    get enabled() {
      return lift !== undefined;
    },
    set,
  };
}
