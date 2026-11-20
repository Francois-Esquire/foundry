import type {
  ModelKind,
  Provider,
  ProviderModelDefinition,
} from "@foundry/models";
import {
  claudeCodeModels,
  claudeCodeProvider,
} from "@foundry/models/claude-code";
import { codexModels, codexProvider } from "@foundry/models/codex";
import { gatewayModels, gatewayProvider } from "@foundry/models/gateway";
import { PI_DEFAULT_MODELS, piProvider } from "@foundry/models/pi";
import { vercelModels, vercelProvider } from "@foundry/models/vercel";
import { z } from "zod";
import type { CliHarness, CliHarnessDescriptor } from "~/lib/cli-harnesses";
import { CLI_HARNESSES } from "~/lib/cli-harnesses";
import { which } from "~/lib/harnesses";
import type { GuestDriver } from "~/lib/sandbox/drivers";
import { FIRST_PARTY_DRIVERS } from "~/lib/sandbox/drivers";

export type ProviderScope = "machine" | "workspace";

export interface ProviderWorkspace {
  readonly dir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly id: string;
  readonly root: string;
}

export interface ProviderSetup<S> {
  readonly defaults?: Partial<Record<ModelKind, string>>;
  readonly env: Readonly<Record<string, string>>;
  readonly id: string;
  readonly models: readonly ProviderModelDefinition[];
  readonly scope: ProviderScope;
  readonly settings: S;
  readonly workspace?: ProviderWorkspace;
}

export interface Execution {
  readonly bin?: string;
  readonly driver: GuestDriver;
  readonly env: Readonly<Record<string, string>>;
  readonly guest: CliHarnessDescriptor<CliHarness>;
  readonly harness: CliHarness;
}

export interface ProviderInstance {
  readonly execution?: Execution;
  readonly provider: Provider;
}

export interface ProviderPlugin<S = unknown> {
  readonly accountEnv?: readonly string[];
  readonly ambient?: true;
  readonly binding?: "workspace";
  catalog(settings: S): readonly ProviderModelDefinition[];
  create(setup: ProviderSetup<S>): ProviderInstance;
  detect?(context: {
    readonly env: Readonly<Record<string, string>>;
  }): S | null;
  readonly id: string;
  readonly label: string;
  list?(context: {
    readonly env: Readonly<Record<string, string>>;
    readonly settings: S;
    readonly signal: AbortSignal;
  }): Promise<readonly ProviderModelDefinition[]>;
  readonly secrets?: readonly string[];
  readonly settings: z.ZodType<S>;
}

const BIN = z.object({ binPath: z.string().optional() });
type Bin = z.infer<typeof BIN>;

function cli(
  name: string,
  settings: Bin,
  env: Readonly<Record<string, string>>
) {
  return settings.binPath ?? which(name, env.PATH);
}

function guestOf(
  harness: CliHarness,
  env: Readonly<Record<string, string>>,
  bin: string | null
): Execution {
  return {
    ...(bin === null ? {} : { bin }),
    driver: FIRST_PARTY_DRIVERS[harness],
    env,
    guest: CLI_HARNESSES[harness],
    harness,
  };
}

export const claudeCodePlugin: ProviderPlugin<Bin> = {
  accountEnv: [
    "HOME",
    "USER",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_*",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_SKIP_VERTEX_AUTH",
    "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
    "ANTHROPIC_*",
    "AWS_*",
    "AZURE_*",
    "GOOGLE_*",
    "GCLOUD_*",
    "CLOUDSDK_*",
    "CLOUD_ML_REGION",
    "VERTEX_REGION_*",
  ],
  catalog: () => [],
  create: ({ defaults, env, id, models, settings }) => {
    const path = scopedCli("claude", settings, env);
    return {
      execution: guestOf("claude-code", env, path),
      provider: claudeCodeProvider({
        config: {
          available: path !== null && models.length > 0,
          ...(path
            ? {
                defaultSettings: {
                  pathToClaudeCodeExecutable: path,
                },
              }
            : {}),
        },
        env,
        id,
        models: [...models],
        ...(defaults ? { defaults } : {}),
      }),
    };
  },
  detect: ({ env }) => (scopedCli("claude", {}, env) === null ? null : {}),
  id: "claude-code",
  label: "Claude Code",
  list: async ({ env, settings, signal }) => {
    const binPath = scopedCli("claude", settings, env);
    return binPath === null
      ? []
      : await claudeCodeModels({ binPath, env, signal });
  },
  settings: BIN,
};

export const codexPlugin: ProviderPlugin<Bin> = {
  accountEnv: ["HOME", "CODEX_*", "OPENAI_*", "AZURE_*"],
  catalog: () => [],
  create: ({ defaults, env, id, models, settings }) => {
    const path = scopedCli("codex", settings, env);
    return {
      execution: guestOf("codex", env, path),
      provider: codexProvider({
        config: {
          available: path !== null && models.length > 0,
          ...(path === null ? {} : { binPath: path }),
        },
        env,
        id,
        models: [...models],
        ...(defaults ? { defaults } : {}),
      }),
    };
  },
  detect: ({ env }) => {
    const path = scopedCli("codex", {}, env);
    return path === null ? null : { binPath: path };
  },
  id: "codex",
  label: "Codex",
  list: async ({ env, settings, signal }) => {
    const binPath = scopedCli("codex", settings, env);
    return binPath === null ? [] : await codexModels({ binPath, env, signal });
  },
  settings: BIN,
};

function scopedCli(
  name: "claude" | "codex",
  settings: Bin,
  env: Readonly<Record<string, string>>
): string | null {
  return settings.binPath || which(name, env.PATH || "");
}

export const piPlugin: ProviderPlugin<Bin> = {
  accountEnv: [
    "HOME",
    "PI_CODING_AGENT_DIR",
    "AI_GATEWAY_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_OAUTH_TOKEN",
    "AWS_*",
    "AZURE_*",
    "CEREBRAS_API_KEY",
    "COPILOT_GITHUB_TOKEN",
    "GCLOUD_PROJECT",
    "GEMINI_API_KEY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GOOGLE_*",
    "GROQ_API_KEY",
    "HF_TOKEN",
    "KIMI_API_KEY",
    "MINIMAX_API_KEY",
    "MINIMAX_CN_API_KEY",
    "MISTRAL_API_KEY",
    "OPENAI_API_KEY",
    "OPENCODE_API_KEY",
    "OPENROUTER_API_KEY",
    "XAI_API_KEY",
    "ZAI_API_KEY",
  ],
  ambient: true,
  catalog: () => PI_DEFAULT_MODELS,
  create: ({ defaults, env, id, models, settings }) => {
    const path = cli("pi", settings, env);
    return {
      execution: guestOf("pi", env, path),
      provider: piProvider({
        config: { available: path !== null },
        id,
        models: [...models],
        ...(defaults ? { defaults } : {}),
      }),
    };
  },
  detect: ({ env }) => (which("pi", env.PATH) === null ? null : {}),
  id: "pi",
  label: "Pi",
  settings: BIN,
};

const VERCEL = z.object({
  apiKey: z.string(),
  baseURL: z.string().optional(),
});

function vercelConfig(
  settings: z.infer<typeof VERCEL>,
  env: Readonly<Record<string, string>>
) {
  const apiKey = env[settings.apiKey];
  return {
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
  };
}

export const vercelPlugin: ProviderPlugin<z.infer<typeof VERCEL>> = {
  catalog: () => [],
  create: ({ defaults, env, id, models, settings }) => ({
    provider: vercelProvider({
      config: vercelConfig(settings, env),
      id,
      models: [...models],
      ...(defaults ? { defaults } : {}),
    }),
  }),
  detect: ({ env }) =>
    env.AI_GATEWAY_API_KEY === undefined
      ? null
      : { apiKey: "AI_GATEWAY_API_KEY" },
  id: "vercel",
  label: "Vercel AI Gateway",
  list: ({ env, settings, signal }) =>
    vercelModels(vercelConfig(settings, env), { signal }),
  secrets: ["apiKey"],
  settings: VERCEL,
};

const GATEWAY = z.strictObject({
  apiKey: z.string().optional(),
  baseURL: z.string(),
});

function gatewayConfig(
  settings: z.infer<typeof GATEWAY>,
  env: Readonly<Record<string, string>>
) {
  return {
    baseURL: settings.baseURL,
    ...(settings.apiKey && env[settings.apiKey] !== undefined
      ? { apiKey: env[settings.apiKey] }
      : {}),
  };
}

export const gatewayPlugin: ProviderPlugin<z.infer<typeof GATEWAY>> = {
  catalog: () => [],
  create: ({ defaults, env, id, models, settings }) => ({
    provider: gatewayProvider({
      config: gatewayConfig(settings, env),
      id,
      models: [...models],
      ...(defaults ? { defaults } : {}),
    }),
  }),
  id: "gateway",
  label: "OpenAI-compatible gateway",
  list: ({ env, settings, signal }) =>
    gatewayModels(gatewayConfig(settings, env), { signal }),
  secrets: ["apiKey"],
  settings: GATEWAY,
};

export type RegisteredPlugin = ProviderPlugin<unknown>;

export function registered<S>(plugin: ProviderPlugin<S>): RegisteredPlugin {
  return plugin as unknown as RegisteredPlugin;
}

export const FIRST_PARTY_PLUGINS: readonly RegisteredPlugin[] = [
  registered(claudeCodePlugin),
  registered(codexPlugin),
  registered(piPlugin),
  registered(vercelPlugin),
  registered(gatewayPlugin),
];
