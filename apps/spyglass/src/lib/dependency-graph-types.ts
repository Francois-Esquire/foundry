import type { SemanticsDeclaredDependencyKind } from "./semantics-types";

export interface DependencyNode {
  id: string;
  kind: "workspace" | "external";
  /** Bun's installation locator distinguishes nested versions and aliases. */
  locator?: string;
  name: string;
  version?: string;
}

export interface DependencyEdge {
  kind: SemanticsDeclaredDependencyKind;
  /** The declared name, which can be an alias for target.name. */
  name: string;
  optional?: boolean;
  range: string;
  resolution: "resolved" | "unresolved";
  source: string;
  target?: string;
}

export interface ResolvedDependencyGraph {
  edges: DependencyEdge[];
  nodes: DependencyNode[];
  resolution: {
    issues: string[];
    source?: "bun.lock";
    status: "complete" | "partial" | "unavailable";
  };
}
