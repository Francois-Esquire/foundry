/**
 * Codex's model list, as the CLI itself reports it.
 *
 * The Codex CLI is the only authority on which models a Codex turn can run —
 * that set follows the user's account and the installed version, so any list
 * written here would be a guess with an expiry date. Asking the binary is the
 * one answer that cannot go stale.
 *
 * What it gives back is thin: an id, a display name, and which provider serves
 * it. No context window, no capabilities. Those come from models.dev, keyed by
 * the same id — which is the division of labour this catalog is built around:
 * the source that knows *which* models exist is rarely the one that knows *what
 * they are*.
 */

import type { ProviderModelDefinition } from "../types";

/** The subset of the CLI's `model/list` reply we rely on. */
export interface CodexModelInfo {
  description?: string | null;
  id: string;
  isDefault?: boolean | null;
  modelProvider?: string | null;
  name?: string | null;
}

/**
 * Codex's listing as catalog rows.
 *
 * Every row is stamped `functionCalling: true`. That is a statement, not a
 * detection: running tools is the entire job of a coding harness, and the
 * selectable catalog filters on precisely this flag — so leaving it unset would
 * drop the whole harness out of the picker with no error anywhere.
 */
export function fromCodexListing(
  models: CodexModelInfo[]
): ProviderModelDefinition[] {
  const rows: ProviderModelDefinition[] = [];
  for (const model of models) {
    if (typeof model.id !== "string" || model.id === "") {
      continue;
    }
    rows.push({
      id: model.id,
      kind: "text",
      label: model.name ?? model.id,
      // Keyed so live discovery replaces the static floor in place.
      modelId: model.id,
      vendor: model.modelProvider ?? "openai",
      ...(model.description ? { description: model.description } : {}),
      capabilities: { functionCalling: true },
    });
  }
  return rows;
}
