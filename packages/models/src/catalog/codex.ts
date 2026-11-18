import type { ProviderModelDefinition } from "../types";

export interface CodexModelInfo {
  description?: string | null;
  id: string;
  isDefault?: boolean | null;
  modelProvider?: string | null;
  name?: string | null;
}

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
      modelId: model.id,
      vendor: model.modelProvider ?? "openai",
      ...(model.description ? { description: model.description } : {}),
      capabilities: { functionCalling: true },
    });
  }
  return rows;
}
