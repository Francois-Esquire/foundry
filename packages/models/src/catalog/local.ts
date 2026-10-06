import type { ProviderModelDefinition } from "../types";

/** The on-device embedding model, shared with the manager-less pipeline. */
export const LOCAL_EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

/** On-device rows run free; an explicit zero keeps them priced, not Unknown. */
export function withLocalCosts<T extends ProviderModelDefinition>(
  defs: T[]
): T[] {
  return defs.map((def) =>
    def.costs ? def : { ...def, costs: { input: 0, output: 0 } }
  );
}
