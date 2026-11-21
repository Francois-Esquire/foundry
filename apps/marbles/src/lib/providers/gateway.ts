import { gatewayModels, gatewayProvider } from "@foundry/models/gateway";
import { z } from "zod";
import type { ProviderPlugin } from "~/lib/providers/plugins";

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

export const gateway: ProviderPlugin<z.infer<typeof GATEWAY>> = {
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
