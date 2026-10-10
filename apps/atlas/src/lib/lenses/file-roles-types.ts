/** Bumped when `FileRoles` changes shape or meaning. */
export const FILE_ROLES_SCHEMA_VERSION = 1;

/**
 * A file's architectural role in its own package, read from the package's
 * internals, first match wins: a composition root is a `junction`; a module
 * whose exported symbols serve more than one scope is `mixed`; one whose
 * exported symbols serve no single responsibility but are consumed across
 * responsibilities or package-wide is `commons`; and one whose every symbol
 * has an unplaced or unclear scope is `unknown`. `unknown` is not a
 * responsibility's `unresolved` belonging.
 */
export type FileRole = "junction" | "mixed" | "commons" | "unknown";

/** One module of a package's internal topology. */
export interface FileRoleModule {
  /**
   * The package's own source modules that import this one, as the topology
   * saved it: distinct primary modules, inside the package only.
   */
  fanIn: number;
  /** Whether the topology gave the module its `high-fan-in` role. */
  highFanIn: boolean;
  /** Root-relative module id, the module index's id. */
  module: string;
  /** Absent for a module with none of the four roles. */
  role?: FileRole;
}

/** One package with internals, by its manifest id. */
export interface FileRolesPackage {
  /**
   * The fan-in at or above which the topology called a module high fan-in,
   * as it saved it: the larger of its minimum and its percentile among the
   * package's modules with any dependent, and 0 when none has one.
   */
  highFanInCutoff: number;
  id: string;
  /** Every module the topology lists, sorted by id. */
  modules: FileRoleModule[];
}

/**
 * The `file-roles` lens: every package whose internals the dataset holds,
 * sorted by id, and the complete packages it holds none for (`missing`),
 * sorted. A package that failed is in neither.
 */
export interface FileRoles {
  missing: string[];
  packages: FileRolesPackage[];
}
