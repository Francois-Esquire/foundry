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
import { spawnRecordedCli, withCliStderr } from "./claude-code-spawn";
import { CLAUDE_CODE_FRESH } from "./cost";
import { liveEnvironmentOverlay } from "./environment";
import type { Provider } from "./provider";
import { vendorClient } from "./provider";
import type { ModelKind, ProviderModelDefinition } from "./types";

export type { ClaudeCodeDriverOptions } from "./harness/claude-code";
// biome-ignore lint/performance/noBarrelFile: Existing provider subpath also exposes its native turn driver.
export { createClaudeCodeDriver } from "./harness/claude-code";

export interface ClaudeCodeProviderConfig extends ClaudeCodeProviderSettings {
  available?: boolean;
}

export interface ClaudeCodeProviderOptions {
  config?: ClaudeCodeProviderConfig;
  defaults?: Partial<Record<ModelKind, string>>;
  env: Readonly<Record<string, string>>;
  id?: string;
  models?: ProviderModelDefinition[];
}

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
          spawnClaudeCodeProcess: spawnRecordedCli,
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
        const result = await withCliStderr(doGenerate).result;
        return own
          ? { ...result, providerMetadata: marked(result.providerMetadata) }
          : result;
      },
      async wrapStream({ doStream }) {
        const own = fresh();
        const call = withCliStderr(doStream);
        const result = await call.result;
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream<
              LanguageModelV4StreamPart,
              LanguageModelV4StreamPart
            >({
              transform(part, controller) {
                if (part.type === "error") {
                  controller.enqueue({
                    ...part,
                    error: call.explain(part.error),
                  });
                } else if (own && part.type === "finish") {
                  controller.enqueue({
                    ...part,
                    providerMetadata: marked(part.providerMetadata),
                  });
                } else {
                  controller.enqueue(part);
                }
              },
            })
          ),
        };
      },
    },
    model,
  });
}

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
