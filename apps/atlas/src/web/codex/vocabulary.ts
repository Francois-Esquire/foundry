type FileKind = "source" | "test" | "story" | "config" | "other" | "unknown";

export type DeclaredDependencyKind =
  | "dependencies"
  | "devDependencies"
  | "peerDependencies"
  | "optionalDependencies";

interface CodexWorkspace {
  coverage: "complete" | "partial";
  surveyedAt: string;
}

interface CodexPackage {
  analyzed: boolean;
  id: string;
  label: string;
  /** Dependency layer; 0 is the foundation. */
  layer: number;
  /** Modules the package holds. */
  size: number;
}

interface CodexModule {
  /** Concepts the module takes part in, in any role. */
  concepts: string[];
  /** Import edges starting here, within and across packages. */
  dependencies: number;
  /** Import edges ending here, within and across packages. */
  dependents: number;
  directory: string;
  fileKind: FileKind;
  id: string;
  package: string;
  path: string;
}

interface CodexImport {
  source: string;
  target: string;
}

interface CodexDependency {
  from: string;
  sharedConcepts: number;
  /** Module import edges from `from` to `to`. */
  strength: number;
  to: string;
}

interface CodexDeclaredDependency {
  from: string;
  kind: DeclaredDependencyKind;
  to: string;
}

export interface CodexRetiredPackage {
  id: string;
  label: string;
  lastSeen: string;
}

export interface Codex {
  declaredDependencies: CodexDeclaredDependency[];
  dependencies: CodexDependency[];
  imports: CodexImport[];
  modules: CodexModule[];
  /** Sorted by id. */
  packages: CodexPackage[];
  /** Absent when no history was recorded; sorted by id. */
  retiredPackages?: CodexRetiredPackage[];
  workspace: CodexWorkspace;
}
