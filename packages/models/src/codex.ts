import { createCodexAppServer } from "ai-sdk-provider-codex-cli";
import { fromCodexListing } from "./catalog/codex";
import { enrichFromSnapshot } from "./catalog/models-dev-snapshot";
import type { Provider } from "./provider";
import type { ProviderModelDefinition } from "./types";

export interface CodexProviderConfig {
  /**
   * Whether the CLI is installed and the user has this harness switched on.
   * The host owns detection; this package never probes the machine. Defaults
   * false so an unconfigured registration fails closed.
   */
  available?: boolean;
  /**
   * Absolute path to the `codex` binary, resolved by the host. A GUI-launched
   * app on macOS inherits only the system PATH, so the SDK's bare `codex`
   * fallback finds nothing in exactly the case that matters.
   */
  binPath?: string;
}

export interface CodexProviderOptions {
  config?: CodexProviderConfig;
  id?: string;
  models?: ProviderModelDefinition[];
}

/**
 * The floor Codex serves from before its CLI has been asked. Minimal on
 * purpose: discovery replaces it wholesale, and the CLI's list follows the
 * user's account, so anything curated here would be a guess with an expiry.
 */
export const CODEX_DEFAULT_MODELS: ProviderModelDefinition[] = [
  {
    capabilities: { functionCalling: true },
    id: "gpt-5.5",
    kind: "text",
    label: "GPT-5.5",
    modelId: "gpt-5.5",
    vendor: "openai",
  },
];

/**
 * Codex as a provider: the CLI runs the turn, spoken to over its app-server
 * JSON-RPC transport. The transport is a persistent child process, which is
 * why `dispose` exists — without it a `codex app-server` outlives the app.
 */
export function codexProvider(
  options: CodexProviderOptions = {}
): Provider<CodexProviderConfig> {
  let config = options.config ?? {};
  let sdk = build(config);

  return {
    get available() {
      return config.available ?? false;
    },
    configure: (patch) => {
      config = { ...config, ...patch };
      sdk = build(config);
    },
    // Gated on availability: spawning a binary that is not installed would
    // turn a missing optional tool into a startup error. The listing carries
    // ids and little else; models.dev supplies windows and capabilities.
    discover: async () => {
      if (!(config.available ?? false)) {
        return [];
      }
      const { models } = await sdk.listModels();
      return enrichFromSnapshot(fromCodexListing(models));
    },
    dispose: () => sdk.close(),
    harness: "codex",
    id: options.id ?? "codex",
    languageModel: (modelId, opts) =>
      sdk.languageModel(
        modelId,
        opts?.workingDirectory ? { cwd: opts.workingDirectory } : undefined
      ),
    models: options.models ?? CODEX_DEFAULT_MODELS,
    offline: false,
  };
}

function build(config: CodexProviderConfig) {
  return createCodexAppServer({
    defaultSettings: {
      ...(config.binPath ? { codexPath: config.binPath } : {}),
      // The CLI's own logging would otherwise land on the host's stdout.
      logger: false,
    },
  });
}
