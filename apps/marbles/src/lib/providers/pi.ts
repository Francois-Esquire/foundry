import { PI_DEFAULT_MODELS, piProvider } from "@foundry/models/providers/pi";
import type { Bin } from "~/lib/providers/cli";
import { BIN, cli, guestOf } from "~/lib/providers/cli";
import type { ProviderPlugin } from "~/lib/providers/plugins";
import { which } from "~/lib/which";

export const pi: ProviderPlugin<Bin> = {
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
  detect: ({ env }) => (which("pi", env.PATH || "") === null ? null : {}),
  id: "pi",
  label: "Pi",
  settings: BIN,
};
