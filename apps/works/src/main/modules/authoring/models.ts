import {
  gatewayProvider,
  type ModelManager,
  type Provider,
  vercelProvider,
} from "@foundry.sh/marbles/engine";
import type { Vault } from "~/main/vault/vault";
import type { AuthoringModels } from "./service";

/** Refresh provider instances from the vault; Models owns selection and leases. */
export function vaultAuthoringModels(
  models: ModelManager,
  vault: Pick<Vault, "resolve">,
  factories: {
    gateway?: typeof gatewayProvider;
    vercel?: typeof vercelProvider;
  } = {}
): AuthoringModels {
  let gateway: { key: string; provider: Provider } | undefined;
  let vercel: { key: string; provider: Provider } | undefined;
  return {
    route() {
      const apiKey = vault.resolve("gateway", "apiKey") ?? undefined;
      const baseURL = vault.resolve("gateway", "baseURL");
      const vercelKey = vault.resolve("vercel", "apiKey") ?? undefined;
      const gatewayKey = JSON.stringify([apiKey, baseURL]);
      let changed = false;
      if (gateway?.key !== gatewayKey) {
        changed = true;
        gateway = {
          key: gatewayKey,
          provider: (factories.gateway ?? gatewayProvider)({
            config: { apiKey, baseURL: baseURL ?? "http://localhost:4000" },
          }),
        };
      }
      const vercelConfig = JSON.stringify([vercelKey]);
      if (vercel?.key !== vercelConfig) {
        changed = true;
        vercel = {
          key: vercelConfig,
          provider: (factories.vercel ?? vercelProvider)({
            config: { apiKey: vercelKey },
          }),
        };
      }
      const providers = [gateway.provider, vercel.provider];
      if (changed) {
        models.setProviders(providers);
      }
      if (!providers.some((provider) => provider.available)) {
        throw new Error(
          "Add a Gateway or Vercel API key in Settings to use the chat."
        );
      }
      return models.resolve("text").route;
    },
  };
}
