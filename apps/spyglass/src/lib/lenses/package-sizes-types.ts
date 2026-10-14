import type { FileKind } from "../types";

/** Bumped when `PackageSizes` changes shape or meaning. */
export const PACKAGE_SIZES_SCHEMA_VERSION = 1;

/** A file's kind; `unknown` for a file the module index gives no kind. */
export type PackageSizeKind = FileKind | "unknown";

/**
 * One package, by its manifest id, and its size: the number of its files, by
 * kind. `analyzed` and `layer` are copied from the dependency graph only so
 * that the viewer's codex reads its packages from this lens and drops its
 * own join.
 */
export interface PackageSize {
  /** Whether the scan analyzed the package; a package that failed has no files here. */
  analyzed: boolean;
  id: string;
  /** Dependency layer, 0 for a package that depends on no other; `null` when the graph could not place it. */
  layer: number | null;
  /** The package's files in the module index: `byKind` counts each kind, and `total` is their sum. */
  modules: { byKind: Record<PackageSizeKind, number>; total: number };
}

/** The `package-sizes` lens: every package in the dependency graph, sorted by id. */
export interface PackageSizes {
  packages: PackageSize[];
}
