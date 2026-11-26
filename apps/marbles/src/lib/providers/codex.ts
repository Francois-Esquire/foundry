import { codexModels, codexProvider } from "@foundry/models/providers/codex";
import { DEFAULT_PROVIDER } from "~/lib/handles";
import type { Bin } from "~/lib/providers/cli";
import { BIN, guestOf, scopedCli } from "~/lib/providers/cli";
import type { ProviderPlugin } from "~/lib/providers/plugins";

export const codex: ProviderPlugin<Bin> = Object.defineProperty(
  {
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
      return binPath === null
        ? []
        : await codexModels({ binPath, env, signal });
    },
    settings: BIN,
  },
  DEFAULT_PROVIDER,
  { value: true }
);
