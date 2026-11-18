import type { PackageInternals } from "../internal-analysis-types";
import type { LensReader } from "./lens-types";

export function rootRelative(root: string, module: string): string {
  return root === "" || root === "." ? module : `${root}/${module}`;
}

export function rootRelativeFolder(root: string, directory: string): string {
  if (directory === ".") {
    return root === "" ? "." : root;
  }
  return rootRelative(root, directory);
}

export interface LensPackageInternals {
  id: string;
  internals: PackageInternals;
  root: string;
}

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
