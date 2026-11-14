import { parseConfigFileTextToJson } from "typescript";
import { nativeRepositoryReader } from "./boundary";
import type { ResolvedDependencyGraph } from "./dependency-graph-types";
import type { DependencyInventory } from "./dependency-inventory-types";
import { resolveDependencyGraphWith } from "./dependency-rules";

export function resolveDependencyGraph(
  root: string,
  inventory: DependencyInventory
): ResolvedDependencyGraph {
  return resolveDependencyGraphWith(
    nativeRepositoryReader,
    root,
    inventory,
    parseConfigFileTextToJson
  );
}
