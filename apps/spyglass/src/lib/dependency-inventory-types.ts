import type { ResolvedDependencyGraph } from "./dependency-graph-types";
import type {
  SemanticsDeclaredDependencies,
  SemanticsSkippedDirectory,
} from "./semantics-types";

export interface DependencyInventoryPackage {
  analysis: "available" | "unsupported";
  declaredDependencies: SemanticsDeclaredDependencies;
  id: string;
  name: string;
  optionalPeers?: string[];
  path: string;
  role: "workspace" | "root";
  version?: string;
}

export interface DependencyInventory {
  graph?: ResolvedDependencyGraph;
  packages: DependencyInventoryPackage[];
  schemaVersion: 1;
  skipped: SemanticsSkippedDirectory[];
  usage?: {
    analyzedPackages: string[];
    unavailablePackages: string[];
    method: "static-imports";
  };
}
