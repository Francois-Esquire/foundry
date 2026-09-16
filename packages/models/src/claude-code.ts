import type { ClaudeCodeProviderSettings } from "ai-sdk-provider-claude-code";

import { createClaudeCode } from "ai-sdk-provider-claude-code";

import type { Provider } from "./provider";
import type { ProviderModelDefinition } from "./types";

export interface ClaudeCodeProviderConfig extends ClaudeCodeProviderSettings {
  /**
   * Whether the CLI is installed and the user has this harness switched on.
   * The host owns detection; this package never probes the machine. Defaults
   * false so an unconfigured registration fails closed.
   */
  available?: boolean;
}

export interface ClaudeCodeProviderOptions {
  config?: ClaudeCodeProviderConfig;
  id?: string;
  models?: ProviderModelDefinition[];
}

/**
 * Family aliases rather than pinned versions: the CLI publishes no catalog,
 * and `claude --model <alias>` resolves each to the latest build in its
 * family, so naming the family cannot go stale. Capabilities are stated, not
 * detected — every current Claude family takes images, reasons, and calls
 * tools, and the picker filters on `functionCalling`.
 */
export const CLAUDE_CODE_DEFAULT_MODELS: ProviderModelDefinition[] = [
  { id: "sonnet", label: "Claude Sonnet (via Claude Code)" },
  { id: "opus", label: "Claude Opus (via Claude Code)" },
  { id: "haiku", label: "Claude Haiku (via Claude Code)" },
  { id: "fable", label: "Claude Fable (via Claude Code)" },
].map(({ id, label }) => ({
  capabilities: { functionCalling: true, reasoning: true, vision: true },
  id,
  kind: "text" as const,
  label,
  limits: { maxInputTokens: 200_000 },
  modelId: id,
  vendor: "anthropic",
}));

/** The Claude Code CLI as a provider; the CLI runs the turn. */
export function claudeCodeProvider(
  options: ClaudeCodeProviderOptions = {}
): Provider<ClaudeCodeProviderConfig> {
  let config = options.config ?? {};
  let sdk = createClaudeCode(config);

  return {
    get available() {
      return config.available ?? false;
    },
    configure: (patch) => {
      config = { ...config, ...patch };
      sdk = createClaudeCode(config);
    },
    harness: "claude-code",
    id: options.id ?? "claude-code",
    languageModel: (modelId, opts) =>
      sdk.languageModel(
        modelId,
        opts?.workingDirectory ? { cwd: opts.workingDirectory } : undefined
      ),
    models: options.models ?? CLAUDE_CODE_DEFAULT_MODELS,
    offline: false,
  };
}
