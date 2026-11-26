import type { ModelInfo } from "ai-sdk-provider-claude-code";
import type { ProviderModelDefinition } from "../../model-definition";

export function fromClaudeCodeListing(
  models: readonly ModelInfo[]
): ProviderModelDefinition[] {
  if (!Array.isArray(models)) {
    throw new Error("Claude Code returned no model list");
  }
  const listed = new Map<string, ProviderModelDefinition>();
  const add = (id: string, model: ModelInfo) => {
    if (!listed.has(id)) {
      listed.set(id, {
        id,
        kind: "text",
        modelId: id,
        vendor: "anthropic",
        ...(model.displayName ? { label: model.displayName } : {}),
        ...(model.description ? { description: model.description } : {}),
      });
    }
  };
  for (const model of models) {
    if (typeof model.value !== "string" || model.value === "") {
      throw new Error("Claude Code returned a model without an id");
    }
    add(model.value, model);
  }
  for (const model of models) {
    if (model.resolvedModel) {
      add(model.resolvedModel, model);
    }
  }
  const preferred = listed.get("default");
  if (preferred === undefined) {
    return [...listed.values()];
  }
  listed.delete("default");
  return [preferred, ...listed.values()];
}
