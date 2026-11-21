import type { Provider } from "@foundry/models";
import type { ProviderPlugin, ProviderScope } from "~/lib/providers/plugins";
import type { ProviderEntryRecord } from "~/lib/providers/store";
import { ConfigurationError } from "~/lib/providers/store";

type Environment = Readonly<Record<string, string>>;

export function accountPatterns(
  plugin: ProviderPlugin,
  settings: unknown
): readonly string[] {
  const named = (plugin.secrets ?? []).flatMap((key) => {
    const name = (settings as Record<string, unknown>)[key];
    return typeof name === "string" ? [name] : [];
  });
  return [...(plugin.accountEnv ?? []), ...named];
}

export function identityMaterial(instance: {
  readonly entry: ProviderEntryRecord;
  readonly env: Environment;
  readonly patterns: readonly string[];
  readonly scope: ProviderScope;
  readonly settings: unknown;
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

export function ambientProblem(
  machine: Environment,
  patterns: readonly string[],
  env: Environment
): string | undefined {
  const differing = [...new Set([...Object.keys(machine), ...Object.keys(env)])]
    .filter((name) => machine[name] !== env[name])
    .sort();
  if (differing.length > 0) {
    return `reads the process environment, which does not hold the workspace's values for ${differing.join(", ")}; set them in the environment the Marbles process starts with, or configure it for the whole machine`;
  }
  const live = liveDifference(patterns, env);
  if (live.length > 0) {
    return `reads the process environment, which holds another account in ${live.join(", ")} than the one supplied`;
  }
  return undefined;
}

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
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(Object.create(null) as Provider, {
    get: (_, name) => {
      if (name === "languageModel") {
        return languageModel;
      }
      const value = Reflect.get(provider, name, provider);
      if (typeof value !== "function") {
        return value;
      }
      if (!methods.has(name)) {
        methods.set(name, value.bind(provider));
      }
      return methods.get(name);
    },
    getOwnPropertyDescriptor: (_, name) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(provider, name);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(provider),
    has: (_, name) => Reflect.has(provider, name),
    ownKeys: () => Reflect.ownKeys(provider),
    set: (_, name, value) => Reflect.set(provider, name, value, provider),
  });
}

function isAccountName(patterns: readonly string[], name: string): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith("*")
      ? name.startsWith(pattern.slice(0, -1))
      : name === pattern
  );
}

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
