import { wrapLanguageModel } from "ai";
import { createPi, type PiProviderSettings } from "ai-sdk-provider-pi";
import type { Provider } from "./provider";
import { vendorClient } from "./provider";
import type { ProviderModelDefinition } from "./types";

export type { PiDriverOptions } from "./harness/pi";
// biome-ignore lint/performance/noBarrelFile: Provider subpaths expose their native turn drivers.
export { createPiDriver } from "./harness/pi";

export interface PiProviderConfig extends PiProviderSettings {
  /** The host owns availability, as for the other CLI providers. */
  available?: boolean;
}

export interface PiProviderOptions {
  config?: PiProviderConfig;
  id?: string;
  models?: ProviderModelDefinition[];
}

/** A model included in the community provider's pinned Pi catalog. */
export const PI_DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";
export const PI_DEFAULT_MODELS: ProviderModelDefinition[] = [
  {
    capabilities: { functionCalling: true, reasoning: true, vision: true },
    id: PI_DEFAULT_MODEL,
    kind: "text",
    label: "Claude Sonnet via Pi",
    modelId: PI_DEFAULT_MODEL,
    vendor: "anthropic",
  },
];

/** Pi's AI SDK provider for model calls; sandbox sessions use the native turn driver. */
export function piProvider(options: PiProviderOptions = {}): Provider {
  const vendor = vendorClient(options.config ?? {}, build);
  return {
    get available() {
      return vendor.config.available ?? false;
    },
    dispose: () => vendor.client.dispose(),
    id: options.id ?? "pi",
    languageModel: (modelId, selection) =>
      // AI SDK's own adapter normalizes the provider's V3 model to our V4 contract.
      wrapLanguageModel({
        middleware: [],
        model: vendor.client.languageModel(
          modelId,
          selection?.workingDirectory
            ? { cwd: selection.workingDirectory }
            : undefined
        ),
      }),
    models: options.models ?? PI_DEFAULT_MODELS,
    offline: false,
    // Pi runs its own tool loop inside one call and takes no limit.
    turnLimit: "unsupported",
  };
}

function build(config: PiProviderConfig) {
  return createPi({
    defaultSettings: {
      logger: false,
      tools: "readOnly",
      ...config.defaultSettings,
    },
  });
}
