import type { Provider } from "@foundry/models";
import type { ProviderScope, RegisteredPlugin } from "~/lib/providers/plugins";
import type { ProviderEntryRecord } from "~/lib/providers/store";
import { ConfigurationError } from "~/lib/providers/store";

type Environment = Readonly<Record<string, string>>;

/** The names that choose an instance's account: its plugin's, and those its secret settings name. */
export function accountPatterns(
  plugin: RegisteredPlugin,
  settings: unknown
): readonly string[] {
  const named = (plugin.secrets ?? []).flatMap((key) => {
    const name = (settings as Record<string, unknown>)[key];
    return typeof name === "string" ? [name] : [];
  });
  return [...(plugin.accountEnv ?? []), ...named];
}

/**
 * What an instance's identity digests: where it is configured, what builds
 * it, its parsed settings, and the values of its account environment.
 */
export function identityMaterial(instance: {
  readonly entry: ProviderEntryRecord;
  readonly env: Environment;
  readonly patterns: readonly string[];
  readonly scope: ProviderScope;
  readonly settings: unknown;
  /** The workspace a workspace-scope entry is bound to. */
  readonly workspace: string | null;
}): unknown {
  const { entry, env, patterns, scope, settings, workspace } = instance;
  const account = Object.keys(env)
    .filter((name) => isAccountName(patterns, name))
    .sort()
    .map((name) => [name, env[name]]);
  return [
    scope,
    workspace,
    entry.plugin,
    entry.id,
    canonical(settings),
    account,
  ];
}

/**
 * Why an instance that reads `process.env` itself cannot serve as `env`, or
 * undefined. The process environment is the machine's with the workspace's
 * values beneath it; the live one must also hold `env`'s account.
 */
export function ambientProblem(
  environment: {
    readonly machine: Environment;
    readonly workspace: Environment;
  },
  patterns: readonly string[],
  env: Environment
): string | undefined {
  const merged = { ...environment.workspace, ...environment.machine };
  const differing = [...new Set([...Object.keys(merged), ...Object.keys(env)])]
    .filter((name) => merged[name] !== env[name])
    .sort();
  if (differing.length > 0) {
    return `reads the process environment, which differs here in ${differing.join(", ")}; configure it for this workspace`;
  }
  const live = liveDifference(patterns, env);
  if (live.length > 0) {
    return `reads the process environment, which holds another account in ${live.join(", ")} than the one supplied`;
  }
  return undefined;
}

/**
 * `provider`, which reads `process.env` itself, refusing each model call
 * while the live account environment differs from the one its identity
 * digests, so a session never runs as an account it was not pinned to.
 */
export function refusingWhenChanged(
  provider: Provider,
  patterns: readonly string[],
  env: Environment
): Provider {
  const admit = () => {
    const differing = liveDifference(patterns, env);
    if (differing.length > 0) {
      throw new ConfigurationError(
        "PROVIDER_ENVIRONMENT_CHANGED",
        `"${provider.id}" reads the process environment, which changed in ${differing.join(", ")} after it was configured`
      );
    }
  };
  const languageModel: Provider["languageModel"] = (modelId, options) => {
    const model = provider.languageModel(modelId, options);
    return {
      doGenerate: async (call) => {
        admit();
        return await model.doGenerate(call);
      },
      doStream: async (call) => {
        admit();
        return await model.doStream(call);
      },
      modelId: model.modelId,
      provider: model.provider,
      specificationVersion: model.specificationVersion,
      get supportedUrls() {
        return model.supportedUrls;
      },
    };
  };
  return new Proxy(provider, {
    get: (target, name, receiver) =>
      name === "languageModel"
        ? languageModel
        : Reflect.get(target, name, receiver),
  });
}

function isAccountName(patterns: readonly string[], name: string): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith("*")
      ? name.startsWith(pattern.slice(0, -1))
      : name === pattern
  );
}

/** Account names where the live `process.env` no longer holds what `env` does. */
function liveDifference(
  patterns: readonly string[],
  env: Environment
): string[] {
  const names = new Set([...Object.keys(env), ...Object.keys(process.env)]);
  return [...names]
    .filter(
      (name) => isAccountName(patterns, name) && process.env[name] !== env[name]
    )
    .sort();
}

/** `value` with every object's keys sorted, so equal settings digest equally. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}
