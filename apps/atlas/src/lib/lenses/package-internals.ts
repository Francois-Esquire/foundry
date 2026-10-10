import type { PackageInternals } from "../internal-analysis-types";
import type { LensReader } from "./lens-types";

// Browser-safe: the viewer joins internals module ids with `rootRelative` too,
// so a lens and the map name a module the same way.

/**
 * A module's root-relative id, the module index's: the package's
 * `topology.package.root` joined to the module's id inside the package. A
 * package at the workspace root (`""` or `"."`) adds no prefix.
 */
export function rootRelative(root: string, module: string): string {
  return root === "" || root === "." ? module : `${root}/${module}`;
}

/**
 * A directory's root-relative id: the package root for the topology's `.`,
 * else `rootRelative`. A package at the workspace root has `.` as its root
 * folder.
 */
export function rootRelativeFolder(root: string, directory: string): string {
  if (directory === ".") {
    return root === "" ? "." : root;
  }
  return rootRelative(root, directory);
}

/** One package's internals as a lens reads them. */
export interface LensPackageInternals {
  id: string;
  internals: PackageInternals;
  /** `topology.package.root`. */
  root: string;
}

/**
 * Every package whose internals the dataset holds, in the manifest's order,
 * and `missing`: the complete packages it holds none for, sorted. A package
 * that failed has no internals and is in neither, since its report says why.
 */
export async function readPackageInternals(reader: LensReader): Promise<{
  missing: string[];
  packages: LensPackageInternals[];
}> {
  const listed = reader.packages();
  const packages = await Promise.all(
    listed
      .filter((pkg) => pkg.internals)
      .map(async (pkg) => {
        const internals = await reader.internals(pkg.id);
        return { id: pkg.id, internals, root: internals.topology.package.root };
      })
  );
  const missing = listed
    .filter((pkg) => pkg.status === "complete" && !pkg.internals)
    .map((pkg) => pkg.id)
    .sort();
  return { missing, packages };
}
