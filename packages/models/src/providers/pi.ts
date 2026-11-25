import { wrapLanguageModel } from "ai";
import { deferredLanguageModel } from "../deferred-language-model";
import type { ModelKind, ProviderModelDefinition } from "../model-definition";
import type { Provider } from "../provider";

export type { PiDriverOptions } from "./pi/driver";
// biome-ignore lint/performance/noBarrelFile: Provider subpaths expose their native turn drivers.
export { createPiDriver } from "./pi/driver";

interface PiLogger {
  debug(msg: string): void;
  error(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
}

interface PiSettings {
  agentDir?: string;
  cwd?: string;
  defaultProvider?: string;
  instructions?: string;
  logger?: PiLogger | false;
  maxToolResultSize?: number;
  sessionId?: string;
  sessionPersistence?: "memory" | "disk";
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  tools?: "coding" | "readOnly" | "all";
  verbose?: boolean;
}

export interface PiProviderConfig {
  available?: boolean;
  defaultSettings?: PiSettings;
}

export interface PiProviderOptions {
  config?: PiProviderConfig;
  defaults?: Partial<Record<ModelKind, string>>;
  id?: string;
  models?: ProviderModelDefinition[];
}

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

export function piProvider(options: PiProviderOptions = {}): Provider {
  let client: ReturnType<typeof build> | undefined;
  const open = () => {
    client ??= build(options.config ?? {});
    return client;
  };
  return {
    get available() {
      return options.config?.available ?? false;
    },
    ...(options.defaults ? { defaults: options.defaults } : {}),
    dispose: async () => {
      const opened = await client?.catch(() => undefined);
      await opened?.dispose();
    },
    id: options.id ?? "pi",
    languageModel: (modelId, selection) =>
      deferredLanguageModel("pi", modelId, async () =>
        wrapLanguageModel({
          middleware: [],
          model: (await open()).languageModel(
            modelId,
            selection?.workingDirectory
              ? { cwd: selection.workingDirectory }
              : undefined
          ),
        })
      ),
    models: options.models ?? PI_DEFAULT_MODELS,
    offline: false,
    turnLimit: "unsupported",
  };
}

async function build(config: PiProviderConfig) {
  const { createPi: create } = await import("ai-sdk-provider-pi");
  return create({
    defaultSettings: {
      logger: false,
      tools: "readOnly",
      ...config.defaultSettings,
    },
  });
}
