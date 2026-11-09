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
 * Tool support is assumed so the selectable catalog includes these rows.
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
