import { nativeRepositoryReader } from "./boundary";
import type { DependencyInventory } from "./dependency-inventory-types";
import { collectDependencyInventoryWith } from "./dependency-rules";
import type { DeclaredDiscovery } from "./semantics-types";

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
