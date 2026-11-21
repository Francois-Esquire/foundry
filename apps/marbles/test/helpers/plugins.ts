import type { ProviderPlugin } from "~/lib/providers/plugins";

export function pluginOf<S>(plugin: ProviderPlugin<S>): ProviderPlugin {
  return plugin;
}
