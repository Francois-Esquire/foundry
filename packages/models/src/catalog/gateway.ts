import type {
  ModelCapabilities,
  ModelCosts,
  ModelKind,
  ProviderModelDefinition,
} from "../types";

export interface GatewayModelGroup {
  input_cost_per_token?: number | null;
  max_input_tokens?: number | null;
  max_output_tokens?: number | null;
  mode?: string | null;
  model_group: string;
  output_cost_per_token?: number | null;
  providers?: string[];
  supported_openai_params?: string[] | null;
  supports_function_calling?: boolean;
  supports_reasoning?: boolean;
  supports_vision?: boolean;
  supports_web_search?: boolean;
}

const KIND_BY_MODE: Record<string, ModelKind> = {
  chat: "text",
  embedding: "embedding",
  image_generation: "image",
  responses: "text",
};

export function fromGateway(
  groups: GatewayModelGroup[]
): ProviderModelDefinition[] {
  const rows: ProviderModelDefinition[] = [];
  for (const group of groups) {
    const kind = KIND_BY_MODE[group.mode ?? ""];
    if (!(kind && group.model_group)) {
      continue;
    }

    const costs = normalizeCosts(group);
    const capabilities = normalizeFlags(group);
    const params = group.supported_openai_params?.length
      ? group.supported_openai_params
      : undefined;
    const limits = {
      ...(group.max_input_tokens == null
        ? {}
        : { maxInputTokens: group.max_input_tokens }),
      ...(group.max_output_tokens == null
        ? {}
        : { maxOutputTokens: group.max_output_tokens }),
    };

    rows.push({
      id: group.model_group,
      kind,
      label: group.model_group,
      modelId: group.model_group,
      ...(group.providers?.[0] ? { vendor: group.providers[0] } : {}),
      ...(costs ? { costs } : {}),
      ...(Object.keys(limits).length > 0 ? { limits } : {}),
      ...(capabilities ? { capabilities } : {}),
      ...(params ? { params } : {}),
    });
  }
  return rows;
}

function normalizeCosts(group: GatewayModelGroup): ModelCosts | undefined {
  const input = group.input_cost_per_token;
  const output = group.output_cost_per_token;
  if (input == null || output == null) {
    return undefined;
  }
  if (input === 0 && output === 0) {
    return undefined;
  }
  return { input: input * 1_000_000, output: output * 1_000_000 };
}

/**
 * Capability flags, preserving the difference between a stated `false` and a
 * field the gateway never mentioned.
 *
 * That distinction is load-bearing once model facts get filled in from an
 * outside catalog: a gateway saying "this model does not call tools" must not
 * be silently contradicted, while a gateway that simply didn't say is fair game
 * to enrich. Collapsing both to "absent" makes those two indistinguishable —
 * and `gpt-5-chat`, which really is the non-tool endpoint, is exactly the row
 * that would flip.
 */
function normalizeFlags(
  group: GatewayModelGroup
): ModelCapabilities | undefined {
  const capabilities: ModelCapabilities = {
    ...(group.supports_function_calling === undefined
      ? {}
      : { functionCalling: group.supports_function_calling }),
    ...(group.supports_vision === undefined
      ? {}
      : { vision: group.supports_vision }),
    ...(group.supports_reasoning === undefined
      ? {}
      : { reasoning: group.supports_reasoning }),
    ...(group.supports_web_search === undefined
      ? {}
      : { webSearch: group.supports_web_search }),
  };
  return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}
