import { trackCreatedDeclaration } from "~/authoring/runtime";
import { PROVIDER_DECLARATION } from "~/lib/handles";
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
  const descriptors = Object.getOwnPropertyDescriptors(provider);
  const tagged = Object.create(Object.getPrototypeOf(provider), {
    ...descriptors,
    [PROVIDER_DECLARATION]: {
      configurable: false,
      enumerable: false,
      value: provider,
      writable: false,
    },
  }) as ProviderPlugin<S>;
  const frozen = Object.freeze(tagged);
  trackCreatedDeclaration(frozen);
  return frozen;
}
