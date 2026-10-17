import { spawn } from "node:child_process";
import { createPiModel } from "./harness/pi-model";
import type { Provider } from "./provider";
import type { ProviderModelDefinition } from "./types";

export type { PiDriverOptions } from "./harness/pi";
// biome-ignore lint/performance/noBarrelFile: Provider subpaths expose their native turn drivers.
export { createPiDriver } from "./harness/pi";

export interface PiProviderConfig {
  /** Host detection owns availability, as for the other CLI providers. */
  available?: boolean;
  binPath?: string;
  env?: Readonly<Record<string, string>>;
  /** Host model calls are read-only by default. Native sandbox tools use their own authority. */
  nativeTools?: readonly string[];
}

export interface PiProviderOptions {
  config?: PiProviderConfig;
  id?: string;
  models?: ProviderModelDefinition[];
}

export const PI_DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";
export const PI_DEFAULT_MODELS: ProviderModelDefinition[] = [
  {
    capabilities: { functionCalling: true, reasoning: true },
    id: PI_DEFAULT_MODEL,
    kind: "text",
    label: "Claude Sonnet via Pi",
    modelId: PI_DEFAULT_MODEL,
    vendor: "anthropic",
  },
];

/** Pi's native loop is available through createPiDriver; model calls are stateless text requests. */
export function piProvider(
  options: PiProviderOptions = {}
): Provider<PiProviderConfig> {
  let config = options.config ?? {};
  return {
    get available() {
      return config.available ?? false;
    },
    configure(patch) {
      config = { ...config, ...patch };
    },
    harness: "pi",
    id: options.id ?? "pi",
    languageModel: (modelId, selection) =>
      createPiModel(modelId, {
        binPath: config.binPath ?? "pi",
        cwd: selection?.workingDirectory ?? process.cwd(),
        env: Object.fromEntries(
          Object.entries({ ...process.env, ...config.env }).filter(
            (entry): entry is [string, string] => entry[1] !== undefined
          )
        ),
        nativeTools: config.nativeTools ?? ["read", "grep", "find", "ls"],
        spawn: async (argv, settings) =>
          spawn(argv[0] ?? "pi", argv.slice(1), {
            cwd: settings.cwd,
            env: settings.env,
            signal: settings.signal,
            stdio: ["pipe", "pipe", "pipe"],
          }),
      }),
    models: options.models ?? PI_DEFAULT_MODELS,
    offline: false,
  };
}
