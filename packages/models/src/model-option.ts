import type { ModelCosts, ProviderModelDefinition } from "./model-definition";

const MODEL_ID_WORD_SEPARATOR_PATTERN = /[-_\s]+/;

export interface ModelOption {
  costs?: ModelCosts;
  group?: string;
  id: string;
  label: string;
  maxInputTokens?: number | null;
  provider: string;
  supportsFunctionCalling?: boolean;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  vendor?: string;
}

export type CatalogRow = ProviderModelDefinition & { provider: string };

export function toModelOption(row: CatalogRow): ModelOption {
  const vendor = row.vendor ?? "other";
  return {
    group: titleCase(vendor),
    id: row.id,
    label: row.label ?? row.id,
    maxInputTokens: row.limits?.maxInputTokens,
    provider: row.provider,
    supportsFunctionCalling: row.capabilities?.functionCalling,
    supportsReasoning: row.capabilities?.reasoning,
    supportsVision: row.capabilities?.vision,
    vendor,
    ...(row.costs ? { costs: row.costs } : {}),
  };
}

export function vendorOf(id: string): string {
  const lower = id.toLowerCase();
  if (lower.startsWith("claude")) {
    return "anthropic";
  }
  if (lower.startsWith("gpt") || lower.startsWith("codex")) {
    return "openai";
  }
  if (lower.startsWith("gemini")) {
    return "google";
  }
  return "other";
}

function titleCase(id: string): string {
  return id
    .split(MODEL_ID_WORD_SEPARATOR_PATTERN)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
