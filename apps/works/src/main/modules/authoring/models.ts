import type { ModelManager } from "@foundry.sh/marbles/engine";
import type { Vault } from "~/main/vault/vault";
import type { AuthoringModels } from "./service";

/**
 * Authoring routes over the engine's model manager. Each call reads the
 * provider credentials from the vault, so keys stay in the host process and
 * a key changed in Settings applies to the next turn. The manager is built
 * with the Gateway and Vercel bindings; the first usable one is the route.
 */
export function vaultAuthoringModels(
  models: ModelManager,
  vault: Pick<Vault, "resolve">
): AuthoringModels {
  let configured: string | undefined;
  return {
    route() {
      const credentials = {
        aiGatewayApiKey: vault.resolve("gateway", "apiKey"),
        aiGatewayUrl: vault.resolve("gateway", "baseURL"),
        vercelApiKey: vault.resolve("vercel", "apiKey"),
      };
      // Reconfigure only on a change; each configure writes an audit event.
      const key = JSON.stringify(credentials);
      if (key !== configured) {
        models.configure(credentials);
        configured = key;
      }
      const provider = models.defaultProviderFor("text");
      if (provider === null) {
        throw new Error(
          "Add a Gateway or Vercel API key in Settings to use the chat."
        );
      }
      const { model } = models.resolveTextExecutor(undefined, provider);
      return { model, provider };
    },
  };
}
