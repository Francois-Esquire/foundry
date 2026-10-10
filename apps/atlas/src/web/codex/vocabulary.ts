import type { FileRolesPackage } from "../../lib/lenses/file-roles-types";
import type {
  PlacementLabel,
  PlacementLevel,
} from "../../lib/lenses/placement-types";
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
  /** Its workspace-relative folder, from the manifest; empty if the manifest does not list it. */
  path: string;
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

/**
 * One place's use against where it lives, from the `placement` lens: a
 * symbol (`path#name`), file, folder, or package (its root path) that a
 * module of another package uses. Consumer modules are counted, never listed.
 */
export interface CodexPlacement {
  /** Consumer modules in each other package, the most first, then by package. */
  away: { modules: number; package: string }[];
  /** Consumer modules in its own package, outside the place. */
  home: number;
  label: PlacementLabel;
  level: PlacementLevel;
  /** The package it lives in. */
  package: string;
  place: string;
  /**
   * Its dominance share: of its consumer modules, the share the one package
   * holding the most holds, its own package counted as one of the
   * packages; for a departing place, `toward`'s. Unindexed consumers are
   * left out, as the lens leaves them out of its label.
   */
  share: number;
  /** The package a departing place departs toward. */
  toward?: string;
  /** Consumer modules in no package; counted, never labelled. */
  unindexed: number;
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
  /** The `placement` lens's places, as the lens sorts them, and the packages it labelled, whose other places no other package uses. */
  placement: { labelled: string[]; places: CodexPlacement[] };
  /** Absent when no history was recorded; sorted by id. */
  retiredPackages?: CodexRetiredPackage[];
  workspace: CodexWorkspace;
}
