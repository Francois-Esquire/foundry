/**
 * The flat, presentation-shaped projection of a catalog row.
 *
 * {@link ProviderModelDefinition} is the domain shape — nested, and organized
 * around what a provider needs to route a call. A picker wants one flat row it
 * can render without walking into three optional objects per cell. This module
 * owns that projection so the flattening rules live in one place rather than
 * being re-derived by every host that draws a model list.
 *
 * It is a **pure leaf**: it imports only `./types`, which itself imports
 * nothing. That is what lets `@foundry/ui` take the type without taking on the
 * package's Node-only runtime (the barrel reaches transformers and the agent
 * SDK, which crash a browser renderer).
 */

import type { ModelCosts, ProviderModelDefinition } from "./types";

/**
 * The harness that runs a turn in-app, as opposed to shelling out to an
 * installed CLI. Matches `ModelProvider.harness`'s default.
 */
export const STUDIO_HARNESS = "studio";

/** One selectable model, flattened for display. */
export interface ModelOption {
  /**
   * Catalog rate card, USD per 1M tokens. The full {@link ModelCosts} rather
   * than a narrowed copy, so tiered and cached rates survive the projection and
   * reach the cost estimate intact. Absent when the provider reports no pricing.
   */
  costs?: ModelCosts;
  group?: string;
  /**
   * Harness that would run a turn on this model (`studio`, `codex`, …). Rows
   * are scoped to the active harness, so a model with no harness belongs to
   * whichever is current — which keeps single-harness callers working unchanged.
   */
  harness?: string;
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
export type CatalogRow = ProviderModelDefinition & {
  provider: string;
  harness?: string;
};

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
    id: row.id,
    label: row.label ?? row.id,
    provider: row.provider,
    ...(row.harness === undefined ? {} : { harness: row.harness }),
    group: titleCase(vendor),
    maxInputTokens: row.limits?.maxInputTokens,
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
export function titleCase(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
