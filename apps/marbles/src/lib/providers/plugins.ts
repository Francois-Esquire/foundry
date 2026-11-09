import type {
  ModelKind,
  Provider,
  ProviderModelDefinition,
} from "@foundry/models";
import {
  GATEWAY_DEFAULT_MODELS,
  VERCEL_DEFAULT_MODELS,
} from "@foundry/models/catalog/defaults";
import {
  CLAUDE_CODE_DEFAULT_MODELS,
  claudeCodeProvider,
} from "@foundry/models/claude-code";
import { CODEX_DEFAULT_MODELS, codexProvider } from "@foundry/models/codex";
import { gatewayProvider } from "@foundry/models/gateway";
import { PI_DEFAULT_MODELS, piProvider } from "@foundry/models/pi";
import { vercelProvider } from "@foundry/models/vercel";
import { z } from "zod";
import type { CliHarness, CliHarnessDescriptor } from "~/lib/cli-harnesses";
import { CLI_HARNESSES } from "~/lib/cli-harnesses";
import { which } from "~/lib/harnesses";
import type { GuestDriver } from "~/lib/sandbox/drivers";
import { FIRST_PARTY_DRIVERS } from "~/lib/sandbox/drivers";

export type ProviderScope = "machine" | "workspace";

/** The hosted workspace a workspace-scope entry is bound to. */
export interface ProviderWorkspace {
  /** Per-workspace state; an instance keeps its own under `<dir>/providers/<id>/`. */
  readonly dir: string;
  /** What the workspace's `.env.schema` resolved, alone. Plugins read `setup.env`. */
  readonly env: Readonly<Record<string, string>>;
  readonly id: string;
  readonly root: string;
}

export interface ProviderSetup<S> {
  readonly defaults?: Partial<Record<ModelKind, string>>;
  /** The only environment the instance and its processes may read. */
  readonly env: Readonly<Record<string, string>>;
  readonly id: string;
  readonly models: readonly ProviderModelDefinition[];
  readonly scope: ProviderScope;
  readonly settings: S;
  /** Present exactly when `scope` is `"workspace"`. */
  readonly workspace?: ProviderWorkspace;
}

/** How a guest session runs this instance's CLI inside a sandbox. */
export interface Execution {
  /** The instance's CLI on the host, when found: host-side logins run it. */
  readonly bin?: string;
  /** Drives the CLI the session prepared in the guest. */
  readonly driver: GuestDriver;
  /** The instance's environment; guest credentials resolve against it. */
  readonly env: Readonly<Record<string, string>>;
  readonly guest: CliHarnessDescriptor<CliHarness>;
  readonly harness: CliHarness;
}

export interface ProviderInstance {
  readonly execution?: Execution;
  readonly provider: Provider;
}

/**
 * The code that builds one kind of provider instance. Registered with the
 * engine; configuration names it by `id` and never by module.
 */
export interface ProviderPlugin<S = unknown> {
  /**
   * Environment names that choose the account the instance acts as, read
   * from its own CLI or SDK; `NAME_*` covers a family. Their values, secrets
   * included, enter only a digest keyed per machine: the instance identity
   * that pins sessions.
   */
  readonly accountEnv?: readonly string[];
  /** The instance reads `process.env` itself, so it serves only when that matches `setup.env`. */
  readonly ambient?: true;
  /** `"workspace"`: entries are valid only at workspace scope. */
  readonly binding?: "workspace";
  /** The supplied catalog. */
  catalog(settings: S): readonly ProviderModelDefinition[];
  create(setup: ProviderSetup<S>): ProviderInstance;
  /** Setup only: settings for an install found in `env`, or null. */
  detect?(context: {
    readonly env: Readonly<Record<string, string>>;
  }): S | null;
  readonly id: string;
  readonly label: string;
  /** Settings keys holding the name of an environment variable, never a value. */
  readonly secrets?: readonly string[];
  readonly settings: z.ZodType<S>;
}

const BIN = z.object({ binPath: z.string().optional() });
type Bin = z.infer<typeof BIN>;

/** The CLI's path: as configured, else found on the instance's own `PATH`. */
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
  // Read from the 2.1.205 and 2.1.319 binaries: Anthropic, Bedrock,
  // Vertex, and Foundry routes and their cloud credentials.
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
  catalog: () => CLAUDE_CODE_DEFAULT_MODELS,
  create: ({ defaults, env, id, models, settings }) => {
    const path = cli("claude", settings, env);
    return {
      execution: guestOf("claude-code", env, path),
      provider: claudeCodeProvider({
        config: {
          available: path !== null,
          ...(settings.binPath
            ? {
                defaultSettings: {
                  pathToClaudeCodeExecutable: settings.binPath,
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
  detect: ({ env }) => (which("claude", env.PATH) === null ? null : {}),
  id: "claude-code",
  label: "Claude Code",
  settings: BIN,
};

export const codexPlugin: ProviderPlugin<Bin> = {
  // `CODEX_*` and `OPENAI_API_KEY` from the binary; the rest of `OPENAI_*`
  // and `AZURE_*` for the providers its config can select.
  accountEnv: ["HOME", "CODEX_*", "OPENAI_*", "AZURE_*"],
  catalog: () => CODEX_DEFAULT_MODELS,
  create: ({ env, id, models, settings }) => {
    const path = cli("codex", settings, env);
    return {
      execution: guestOf("codex", env, path),
      provider: codexProvider({
        config: {
          available: path !== null,
          ...(path === null ? {} : { binPath: path }),
        },
        env,
        id,
        models: [...models],
      }),
    };
  },
  detect: ({ env }) => {
    const path = which("codex", env.PATH);
    return path === null ? null : { binPath: path };
  },
  id: "codex",
  label: "Codex",
  settings: BIN,
};

export const piPlugin: ProviderPlugin<Bin> = {
  // Every name pi-ai's key lookup and cloud providers read.
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
  // Pi's SDK runs in this process and reads `process.env` for its keys.
  ambient: true,
  catalog: () => PI_DEFAULT_MODELS,
  create: ({ env, id, models, settings }) => {
    const path = cli("pi", settings, env);
    return {
      execution: guestOf("pi", env, path),
      provider: piProvider({
        config: { available: path !== null },
        id,
        models: [...models],
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

export const vercelPlugin: ProviderPlugin<z.infer<typeof VERCEL>> = {
  catalog: () => VERCEL_DEFAULT_MODELS,
  create: ({ defaults, env, id, models, settings }) => ({
    provider: vercelProvider({
      config: {
        ...(env[settings.apiKey] === undefined
          ? {}
          : { apiKey: env[settings.apiKey] }),
        ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
      },
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
  secrets: ["apiKey"],
  settings: VERCEL,
};

const GATEWAY = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string(),
});

export const gatewayPlugin: ProviderPlugin<z.infer<typeof GATEWAY>> = {
  catalog: () => GATEWAY_DEFAULT_MODELS,
  create: ({ defaults, env, id, models, settings }) => ({
    provider: gatewayProvider({
      config: {
        baseURL: settings.baseURL,
        ...(settings.apiKey && env[settings.apiKey] !== undefined
          ? { apiKey: env[settings.apiKey] }
          : {}),
      },
      id,
      models: [...models],
      ...(defaults ? { defaults } : {}),
    }),
  }),
  id: "gateway",
  label: "OpenAI-compatible gateway",
  secrets: ["apiKey"],
  settings: GATEWAY,
};

/**
 * A plugin as the registry holds it. Its settings type is erased; the
 * configuration parses settings with the plugin's own schema before calling
 * `catalog` or `create`, so the erasure never lets a wrong shape through.
 */
export type RegisteredPlugin = ProviderPlugin<unknown>;

export function registered<S>(plugin: ProviderPlugin<S>): RegisteredPlugin {
  return plugin as unknown as RegisteredPlugin;
}

/** The plugins Marbles registers unless a host supplies its own. */
export const FIRST_PARTY_PLUGINS: readonly RegisteredPlugin[] = [
  registered(claudeCodePlugin),
  registered(codexPlugin),
  registered(piPlugin),
  registered(vercelPlugin),
  registered(gatewayPlugin),
];
