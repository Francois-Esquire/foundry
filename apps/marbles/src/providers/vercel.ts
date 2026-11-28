import { vercelModels, vercelProvider } from "@foundry/models/providers/vercel";
import { z } from "zod";
import type { ProviderPlugin } from "~/lib/providers/plugins";

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

export const vercel: ProviderPlugin<z.infer<typeof VERCEL>> = {
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
