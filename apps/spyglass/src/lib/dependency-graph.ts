import { parseConfigFileTextToJson } from "typescript";
import { nativeRepositoryReader } from "./boundary";
import type { ResolvedDependencyGraph } from "./dependency-graph-types";
import type { DependencyInventory } from "./dependency-inventory-types";
import { resolveDependencyGraphWith } from "./dependency-rules";

// The native dependency graph: the rules are `dependency-rules.ts`, answered
// with a native read of `bun.lock`, parsed by the package's own TypeScript.

/** Read saved installation evidence without installing packages or guessing versions. */
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
