import type { Models, ProviderPolicy } from "./models";
import { heldProviders } from "./models";
import type { Provider } from "./provider";

export interface AirplaneMode {
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

export function airplaneMode(models: Models): AirplaneMode {
  let lift: (() => void) | undefined;
  const offline = new Set<Provider>();

  const tell = (provider: Provider, value: boolean) => {
    const failed = (error: unknown) => {
      const heard = models.events.emit("offline-failed", {
        error,
        offline: value,
        provider: provider.id,
      });
      if (
        !heard &&
        typeof process !== "undefined" &&
        typeof process.emitWarning === "function"
      ) {
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

  const retired = (provider: Provider) => {
    offline.delete(provider);
  };

  const joined = () => {
    for (const provider of heldProviders(models)) {
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
