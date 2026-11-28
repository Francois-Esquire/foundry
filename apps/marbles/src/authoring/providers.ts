import { callSite, originOf } from "~/authoring/identity";
import { providingCatalog } from "~/authoring/runtime";
import type { ProviderPlugin } from "~/lib/providers/plugins";

export type {
  ProviderInstance,
  ProviderPlugin,
  ProviderSetup,
} from "~/lib/providers/plugins";

export function defineProvider<S>(
  provider: ProviderPlugin<S>
): ProviderPlugin<S> {
  if (
    typeof provider?.id !== "string" ||
    typeof provider.create !== "function"
  ) {
    throw new TypeError(
      "defineProvider: pass a provider, such as vercel from @foundry.sh/marbles/providers/vercel, or an object with an id, a label, settings, catalog() and create()"
    );
  }
  const site = callSite();
  providingCatalog(provider.id).provide(
    provider,
    site === undefined ? undefined : originOf(site)
  );
  return provider;
}
