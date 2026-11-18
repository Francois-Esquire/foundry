import type { ProviderModelDefinition } from "../types";

export const LOCAL_EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

export function withLocalCosts<T extends ProviderModelDefinition>(
  defs: T[]
): T[] {
  return defs.map((def) =>
    def.costs ? def : { ...def, costs: { input: 0, output: 0 } }
  );
}
