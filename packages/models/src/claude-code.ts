import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
  SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import type {
  ClaudeCodeProviderSettings,
  ClaudeCodeSettings,
} from "ai-sdk-provider-claude-code";
import { createClaudeCode } from "ai-sdk-provider-claude-code";
import { CLAUDE_CODE_FRESH } from "./cost";
import { liveEnvironmentOverlay } from "./environment";
import type { Provider } from "./provider";
import { vendorClient } from "./provider";
import type { ModelKind, ProviderModelDefinition } from "./types";

export type { ClaudeCodeDriverOptions } from "./harness/claude-code";
// biome-ignore lint/performance/noBarrelFile: Existing provider subpath also exposes its native turn driver.
export { createClaudeCodeDriver } from "./harness/claude-code";

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
  /** Catalog id to prefer per kind when the caller names none. */
  defaults?: Partial<Record<ModelKind, string>>;
  /** The only environment the CLI may see; names outside it are removed. */
  env: Readonly<Record<string, string>>;
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

const CLAUDE_CODE_MAX_TURNS = 100;

/** The Claude Code CLI as a provider; the CLI runs the turn. */
export function claudeCodeProvider(
  options: ClaudeCodeProviderOptions
): Provider {
  const vendor = vendorClient(options.config ?? {}, (config) =>
    createClaudeCode(withoutEnvironment(config))
  );

  return {
    get available() {
      return vendor.config.available ?? false;
    },
    ...(options.defaults ? { defaults: options.defaults } : {}),
    id: options.id ?? "claude-code",
    languageModel: (modelId, opts) => {
      const limit = opts?.nativeMaxTurns;
      if (
        limit !== undefined &&
        (!Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > CLAUDE_CODE_MAX_TURNS)
      ) {
        throw new Error(
          `Claude Code maxTurns must be an integer between 1 and ${CLAUDE_CODE_MAX_TURNS}`
        );
      }
      return markFreshCalls(
        vendor.client.languageModel(modelId, {
          env: liveEnvironmentOverlay(options.env, undefined),
          ...(opts?.workingDirectory ? { cwd: opts.workingDirectory } : {}),
          ...(limit === undefined ? {} : { maxTurns: limit }),
        })
      );
    },
    models: options.models ?? CLAUDE_CODE_DEFAULT_MODELS,
    offline: false,
    turnLimit: "native",
  };
}

/**
 * Whether a call with these settings resumes nothing it was told to: no
 * `resume`, `continue` or `sessionId`, in the settings or their
 * `sdkOptions` overlay, and no `extraArgs`, which could pass the CLI a
 * resume flag of their own. Settings it cannot read prove nothing.
 */
function resumesNothing(settings: ClaudeCodeSettings | undefined): boolean {
  if (!settings) {
    return false;
  }
  const sdk = settings.sdkOptions;
  return (
    settings.resume === undefined &&
    sdk?.resume === undefined &&
    settings.continue !== true &&
    sdk?.continue !== true &&
    settings.sessionId === undefined &&
    sdk?.sessionId === undefined &&
    settings.extraArgs === undefined &&
    sdk?.extraArgs === undefined
  );
}

function marked(
  metadata: SharedV4ProviderMetadata | undefined
): SharedV4ProviderMetadata {
  return {
    ...metadata,
    [CLAUDE_CODE_FRESH.key]: {
      ...metadata?.[CLAUDE_CODE_FRESH.key],
      [CLAUDE_CODE_FRESH.field]: true,
    },
  };
}

/**
 * Mark the call that resumed no session (see `CLAUDE_CODE_FRESH`). The
 * settings are the instance's own, default settings merged in. Only the
 * first call on an instance can be fresh: once a call has started, the
 * instance resumes the session the CLI opened for it. Every other call is
 * passed through unmarked.
 */
function markFreshCalls(model: LanguageModelV4): LanguageModelV4 {
  let started = false;
  const fresh = () => {
    const first = !started;
    started = true;
    return (
      first &&
      resumesNothing((model as { settings?: ClaudeCodeSettings }).settings)
    );
  };
  return wrapLanguageModel({
    middleware: {
      specificationVersion: "v4",
      async wrapGenerate({ doGenerate }) {
        const own = fresh();
        const result = await doGenerate();
        return own
          ? { ...result, providerMetadata: marked(result.providerMetadata) }
          : result;
      },
      async wrapStream({ doStream }) {
        const own = fresh();
        const result = await doStream();
        if (!own) {
          return result;
        }
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream<
              LanguageModelV4StreamPart,
              LanguageModelV4StreamPart
            >({
              transform(part, controller) {
                controller.enqueue(
                  part.type === "finish"
                    ? {
                        ...part,
                        providerMetadata: marked(part.providerMetadata),
                      }
                    : part
                );
              },
            })
          ),
        };
      },
    },
    model,
  });
}

/** The environment comes only from `env`; config that would set or bypass it is refused. */
function withoutEnvironment(
  config: ClaudeCodeProviderConfig
): ClaudeCodeProviderConfig {
  const settings = config.defaultSettings;
  if (
    settings?.env !== undefined ||
    settings?.spawnClaudeCodeProcess !== undefined ||
    settings?.sdkOptions?.env !== undefined ||
    settings?.sdkOptions?.spawnClaudeCodeProcess !== undefined
  ) {
    throw new Error(
      "Claude Code takes its environment only from the provider's env option"
    );
  }
  return config;
}
