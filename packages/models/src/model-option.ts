/** Flatten catalog rows for model pickers without importing runtime code. */

import type { ModelCosts, ProviderModelDefinition } from "./types";

const MODEL_ID_WORD_SEPARATOR_PATTERN = /[-_\s]+/;

/** One selectable model, flattened for display. */
export interface ModelOption {
  /**
   * Catalog rate card, USD per 1M tokens. The full {@link ModelCosts} rather
   * than a narrowed copy, so tiered and cached rates survive the projection and
   * reach the cost estimate intact. Absent when the provider reports no pricing.
   */
  costs?: ModelCosts;
  group?: string;
  id: string;
  label: string;
  maxInputTokens?: number | null;
  /**
   * Provider that serves this model (`gateway`, `vercel`, `local`, …) — the
   * routing target, chosen in the picker's source pane rather than its list.
   */
  provider: string;
  supportsFunctionCalling?: boolean;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  /** Model maker (OpenAI, Anthropic, …) — the in-list group heading. */
  vendor?: string;
}

/** A catalog row tagged with where it came from. */
export type CatalogRow = ProviderModelDefinition & { provider: string };

/**
 * Flatten a catalog row for display.
 *
 * `vendor` names the maker and drives the group heading; `provider` names the
 * routing target. They are deliberately distinct — a model made by Anthropic
 * can be served by the gateway, by Vercel, or by a CLI harness.
 */
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

/**
 * Vendor from a bare model id, for rows whose source names no maker — a CLI
 * harness reports slugs, not provenance. Prefix matching only: a guess beyond
 * that would mislabel more than it fixed.
 */
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

/** Id → label: `vercel` → "Vercel", `ai_gateway` → "Ai Gateway". */
function titleCase(id: string): string {
  return id
    .split(MODEL_ID_WORD_SEPARATOR_PATTERN)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
