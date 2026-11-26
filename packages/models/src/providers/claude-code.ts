import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
  SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import type {
  ClaudeCodeProviderSettings,
  ClaudeCodeSettings,
  createClaudeCode,
  Query,
  WarmQuery,
} from "ai-sdk-provider-claude-code";
import { CLAUDE_CODE_FRESH } from "../cost";
import { deferredLanguageModel } from "../deferred-language-model";
import type { ModelKind, ProviderModelDefinition } from "../model-definition";
import type { Provider } from "../provider";
import { fromClaudeCodeListing } from "./claude-code/listing";
import { spawnRecordedCli, withCliStderr } from "./claude-code/spawn";
import { liveEnvironmentOverlay } from "./environment-overlay";

export type { ClaudeCodeDriverOptions } from "./claude-code/driver";
// biome-ignore lint/performance/noBarrelFile: Existing provider subpath also exposes its native turn driver.
export { createClaudeCodeDriver } from "./claude-code/driver";

export interface ClaudeCodeProviderConfig {
  available?: boolean;
  defaultSettings?: object;
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

export async function claudeCodeModels({
  binPath,
  env,
  signal,
}: {
  readonly binPath: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}): Promise<ProviderModelDefinition[]> {
  signal?.throwIfAborted();
  if (!(env.CLAUDE_CONFIG_DIR || env.HOME)) {
    throw new Error(
      "Claude Code discovery requires HOME or CLAUDE_CONFIG_DIR in the provider environment"
    );
  }
  const cwd = await mkdtemp(join(tmpdir(), "claude-code-models-"));
  const abortController = new AbortController();
  const abort = () => abortController.abort(signal?.reason);
  let warm: WarmQuery | undefined;
  let query: Query | undefined;
  try {
    signal?.throwIfAborted();
    signal?.addEventListener("abort", abort, { once: true });
    const { startup } = await import("ai-sdk-provider-claude-code");
    signal?.throwIfAborted();
    warm = await startup({
      initializeTimeoutMs: 4000,
      options: {
        abortController,
        allowedTools: [],
        cwd,
        env: liveEnvironmentOverlay(env, undefined),
        mcpServers: {},
        pathToClaudeCodeExecutable: binPath,
        permissionMode: "dontAsk",
        persistSession: false,
        settingSources: [],
        settings: { disableAllHooks: true },
        spawnClaudeCodeProcess: spawnRecordedCli,
        strictMcpConfig: true,
        tools: [],
      },
    });
    signal?.throwIfAborted();
    query = warm.query(noMessages(abortController.signal));
    const offered = await query.supportedModels();
    signal?.throwIfAborted();
    return fromClaudeCodeListing(offered);
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error("Claude Code SDK could not list models", { cause: error });
  } finally {
    signal?.removeEventListener("abort", abort);
    abortController.abort();
    try {
      query?.close();
    } finally {
      try {
        warm?.close();
      } finally {
        await rm(cwd, { force: true, recursive: true });
      }
    }
  }
}

function noMessages(signal: AbortSignal): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]: () => ({
      async next() {
        if (!signal.aborted) {
          await once(signal, "abort");
        }
        return { done: true, value: undefined };
      },
    }),
  };
}

export function claudeCodeProvider(
  options: ClaudeCodeProviderOptions
): Provider {
  const config = withoutEnvironment(options.config ?? {});
  let client: Promise<ReturnType<typeof createClaudeCode>> | undefined;
  const open = () => {
    client ??= import("ai-sdk-provider-claude-code").then((sdk) =>
      sdk.createClaudeCode(config as ClaudeCodeProviderSettings)
    );
    return client;
  };

  return {
    get available() {
      return config.available ?? false;
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
      const settings = {
        env: liveEnvironmentOverlay(options.env, undefined),
        spawnClaudeCodeProcess: spawnRecordedCli,
        ...(opts?.workingDirectory ? { cwd: opts.workingDirectory } : {}),
        ...(limit === undefined ? {} : { maxTurns: limit }),
      };
      return deferredLanguageModel("claude-code", modelId, async () =>
        markFreshCalls((await open()).languageModel(modelId, settings))
      );
    },
    models: options.models ?? [],
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
  const settings = config.defaultSettings as ClaudeCodeSettings | undefined;
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
