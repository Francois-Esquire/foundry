import { nativeRepositoryReader } from "./boundary";
import type { DependencyInventory } from "./dependency-inventory-types";
import { collectDependencyInventoryWith } from "./dependency-rules";
import type { DeclaredDiscovery } from "./semantics-types";

// The native dependency inventory: the rules are `dependency-rules.ts`,
// answered with native reads of each package's `package.json`.

/** Reuse discovery's exclusions; only source-language coverage is broadened. */
export function collectDependencyInventory(
  root: string,
  discovery: DeclaredDiscovery
): DependencyInventory {
  return collectDependencyInventoryWith(
    nativeRepositoryReader,
    root,
    discovery
  );
}
