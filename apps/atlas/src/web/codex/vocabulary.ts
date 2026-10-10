import type { FileRolesPackage } from "../../lib/lenses/file-roles-types";
import type { PackageResponsibilityGroups } from "../../lib/lenses/responsibility-groups-types";
import type { SemanticsDeclaredDependencyKind } from "../../lib/semantics-types";

type FileKind = "source" | "test" | "story" | "config" | "other" | "unknown";

interface CodexWorkspace {
  coverage: "complete" | "partial";
  surveyedAt: string;
}

interface CodexPackage {
  analyzed: boolean;
  /** The `file-roles` lens's modules, bound on entering the island; `undefined` when the dataset holds no internals for the package. */
  fileRoles: Pick<FileRolesPackage, "modules"> | undefined;
  /** The internal fan-in at which the package's topology calls a module high fan-in; 0 when it has no cutoff, as without internals. */
  highFanInCutoff: number;
  id: string;
  label: string;
  /** Dependency layer; 0 is the foundation, `null` where the graph could not place the package. */
  layer: number | null;
  /** The `responsibility-groups` lens's groups, drawn on entering the island; `undefined` without internals. */
  responsibilityGroups: PackageResponsibilityGroups | undefined;
  /** Modules the package holds. */
  size: number;
}

interface CodexModule {
  /** Import edges starting here, within and across packages. */
  dependencies: number;
  /** Import edges ending here, within and across packages. */
  dependents: number;
  directory: string;
  fileKind: FileKind;
  /** Whether its topology gave it the `high-fan-in` role; never without internals. */
  highFanIn: boolean;
  id: string;
  /** Source modules of its own package importing it, as its topology saved it; 0 without internals. */
  internalFanIn: number;
  package: string;
  path: string;
}

interface CodexImport {
  source: string;
  target: string;
}

interface CodexDependency {
  /** Files of `from` that import a file of `to`, sorted. */
  consumerFiles: readonly string[];
  from: string;
  sharedConcepts: number;
  /** Module import edges from `from` to `to`. */
  strength: number;
  /** Files of `to` that a file of `from` imports, sorted. */
  supplierFiles: readonly string[];
  to: string;
}

interface CodexDeclaredDependency {
  from: string;
  kind: SemanticsDeclaredDependencyKind;
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
