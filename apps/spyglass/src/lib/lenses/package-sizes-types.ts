import type { FileKind } from "../types";

export const PACKAGE_SIZES_SCHEMA_VERSION = 1;

export type PackageSizeKind = FileKind | "unknown";

export interface PackageSize {
  analyzed: boolean;
  id: string;
  layer: number | null;
  modules: { byKind: Record<PackageSizeKind, number>; total: number };
}

export interface PackageSizes {
  packages: PackageSize[];
}
