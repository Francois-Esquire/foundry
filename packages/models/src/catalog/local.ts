import type { ProviderModelDefinition } from "../types";

export function withLocalCosts<T extends ProviderModelDefinition>(
  defs: T[]
): T[] {
  return defs.map((def) =>
    def.costs ? def : { ...def, costs: { input: 0, output: 0 } }
  );
}
