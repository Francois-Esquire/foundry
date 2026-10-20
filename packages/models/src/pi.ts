import { wrapLanguageModel } from "ai";
import { createPi, type PiProviderSettings } from "ai-sdk-provider-pi";
import type { Provider } from "./provider";
import { configured } from "./provider";
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
export function piProvider(
  options: PiProviderOptions = {}
): Provider<PiProviderConfig> {
  const vendor = configured(options.config ?? {}, build);
  const retired = new Set<ReturnType<typeof createPi>>();
  return {
    get available() {
      return vendor.config.available ?? false;
    },
    configure(patch) {
      retired.add(vendor.client);
      vendor.configure(patch);
    },
    async dispose() {
      retired.add(vendor.client);
      await Promise.all([...retired].map((client) => client.dispose()));
      retired.clear();
    },
    harness: "pi",
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
