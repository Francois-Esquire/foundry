import type {
  SemanticsDeclaredDependencies,
  SemanticsSkippedDirectory,
} from "./semantics-types";

/** Manifest registration is independent of TypeScript analysis coverage. */
export interface DependencyInventoryPackage {
  analysis: "available" | "unsupported";
  declaredDependencies: SemanticsDeclaredDependencies;
  id: string;
  name: string;
  path: string;
  /** Workspace roots contribute tooling, not another island. */
  role: "workspace" | "root";
  version?: string;
}

export interface DependencyInventory {
  packages: DependencyInventoryPackage[];
  schemaVersion: 1;
  skipped: SemanticsSkippedDirectory[];
}
