import type { SemanticsDeclaredDependencyKind } from "./semantics-types";

export interface DependencyNode {
  id: string;
  kind: "workspace" | "external";
  locator?: string;
  name: string;
  version?: string;
}

export interface DependencyEdge {
  kind: SemanticsDeclaredDependencyKind;
  name: string;
  optional?: boolean;
  range: string;
  resolution: "resolved" | "unresolved";
  source: string;
  target?: string;
  usage?: {
    importingFiles: string[];
    runtimeFiles: string[];
    typeOnlyFiles: string[];
  };
}

export interface ResolvedDependencyGraph {
  edges: DependencyEdge[];
  nodes: DependencyNode[];
  resolution: {
    issues: string[];
    source?: "bun.lock";
    status: "complete" | "partial" | "unavailable";
  };
  schemaVersion: 1;
}
