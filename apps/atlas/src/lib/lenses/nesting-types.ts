/** Bumped when `Nesting` changes shape or meaning. */
export const NESTING_SCHEMA_VERSION = 1;

/**
 * One folder of the workspace's one tree: every folder that holds a file of
 * the module index, directly or below, up to the top of the workspace. A
 * package's root is a folder too. The id is the folder's workspace-relative
 * path; a package at the workspace root has the root as its folder, `.`,
 * which no facet can name.
 */
export interface NestingFolder {
  /** The module index's files of every kind, directly in the folder and anywhere below it. */
  fileCounts: { descendant: number; direct: number };
  id: string;
  /** The package that owns the folder, by manifest id: the nearest package root at or above it. Absent for a folder above every package root, such as `packages`. */
  package?: string;
  /** Whether the folder is its package's root. */
  packageRoot: boolean;
  /** The folder holding this one; absent at the top of the workspace. */
  parent?: string;
  /**
   * The path region the owning package's internal topology puts the folder
   * in; absent when the package has no internals, or its topology lists no
   * such directory. A region holding no files has no entry in
   * `Nesting.pathRegions`, though a folder may still name it: the topology
   * leaves out the root region `.` when no file sits directly in the root,
   * yet puts the root folder in it.
   */
  pathRegion?: string;
}

/**
 * A path region of one package, as its internal topology names it: the
 * folders below the package root after a technical root such as `src`,
 * `.` for the root itself. Only regions that hold files are listed.
 */
export interface NestingPathRegion {
  /** The topology's modules in the region, of every kind. */
  files: number;
  /** The region's id within its package. */
  id: string;
  /** By manifest id. */
  package: string;
  /** The region's source files, which its primary edges join. */
  primaryFiles: number;
}

/** The primary edges from one path region into another of one package. */
export interface NestingSeam {
  from: string;
  importSites: number;
  moduleEdges: number;
  /** By manifest id. */
  package: string;
  /** Distinct symbol names crossing. */
  symbolFlow: number;
  to: string;
}

/**
 * The `nesting` lens. `folders` is one tree across every analyzed package,
 * built from the module index, sorted by id. `pathRegions` and `seams`
 * come from the packages' internals, sorted by package and then by region;
 * `missing` lists the complete packages without internals, whose folders
 * are in the tree but whose path regions and seams are not. A package that
 * failed has no files in the module index and is in none of them.
 */
export interface Nesting {
  folders: NestingFolder[];
  missing: string[];
  pathRegions: NestingPathRegion[];
  seams: NestingSeam[];
}
