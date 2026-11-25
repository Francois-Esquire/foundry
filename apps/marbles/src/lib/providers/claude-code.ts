import {
  claudeCodeModels,
  claudeCodeProvider,
} from "@foundry/models/node/claude-code";
import type { Bin } from "~/lib/providers/cli";
import { BIN, guestOf, scopedCli } from "~/lib/providers/cli";
import type { ProviderPlugin } from "~/lib/providers/plugins";

export const claudeCode: ProviderPlugin<Bin> = {
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
