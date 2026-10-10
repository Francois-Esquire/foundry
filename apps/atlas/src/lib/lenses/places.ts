import type { DomainPlaceKind } from "./domains-types";
import type { LensReader } from "./lens-types";
import { folderOf, WORKSPACE_ROOT } from "./paths";

// The places of a dataset that a facet can name, and how a facet names
// one: shared by the lenses that match the configuration's facets (domain
// facets and rule subjects) so that both match alike.

/** What the place index is built from: the module index's files, the named package roots, and the symbol ids read. */
export interface PlacesSource {
  /** Every file of the module index, workspace-relative. */
  files: readonly string[];
  /** Each complete package's root path, a package at the workspace root left out (`packageRoots`). */
  packages: readonly string[];
  /** Symbol ids of the packages symbol facets name (`readSymbols`). */
  symbols: readonly string[];
}

/** The places of the dataset a facet can name, by kind. */
export interface Places {
  files: ReadonlySet<string>;
  folders: ReadonlySet<string>;
  packages: ReadonlySet<string>;
  symbols: ReadonlySet<string>;
}

export function placesOf(source: PlacesSource): Places {
  const folders = new Set<string>();
  for (const file of source.files) {
    for (
      let folder = folderOf(file);
      folder !== WORKSPACE_ROOT && !folders.has(folder);
      folder = folderOf(folder)
    ) {
      folders.add(folder);
    }
  }
  return {
    files: new Set(source.files),
    folders,
    packages: new Set(source.packages),
    symbols: new Set(source.symbols),
  };
}

/** The kind of place a facet names, or `undefined` when it names none; a package's path is a package before it is a folder. */
export function kindOf(
  facet: string,
  places: Places
): DomainPlaceKind | undefined {
  if (facet.includes("#")) {
    return places.symbols.has(facet) ? "symbol" : undefined;
  }
  if (places.packages.has(facet)) {
    return "package";
  }
  if (places.files.has(facet)) {
    return "file";
  }
  return places.folders.has(facet) ? "folder" : undefined;
}

function isWorkspaceRoot(root: string): boolean {
  return root === "" || root === WORKSPACE_ROOT;
}

/** The root path of every complete package; a package at the workspace root has none a facet can name. */
export function packageRoots(
  listed: ReturnType<LensReader["packages"]>
): string[] {
  return listed
    .filter((pkg) => pkg.status === "complete")
    .map((pkg) => pkg.path)
    .filter((path) => !isWorkspaceRoot(path));
}

/** Whether a package root holds a path; a root at the workspace root holds every path. */
function holds(root: string, path: string): boolean {
  return isWorkspaceRoot(root) || path.startsWith(`${root}/`);
}

/** How deep a package root sits: 0 at the workspace root, else its number of segments. */
function rootDepth(root: string): number {
  return isWorkspaceRoot(root) ? 0 : root.split("/").length;
}

/**
 * The complete packages whose report can hold a symbol facet's symbol: for
 * each facet's file, the package with the deepest root holding it, in the
 * manifest's order. A file in a package that failed has no report to read.
 */
export function packagesNamedBySymbols(
  listed: ReturnType<LensReader["packages"]>,
  facets: readonly string[]
): string[] {
  const owners = new Set<string>();
  for (const facet of facets) {
    const [file, symbol] = facet.split("#");
    if (file === undefined || symbol === undefined) {
      continue;
    }
    const owner = listed
      .filter((pkg) => holds(pkg.path, file))
      .reduce<(typeof listed)[number] | undefined>(
        (deepest, pkg) =>
          deepest === undefined || rootDepth(pkg.path) > rootDepth(deepest.path)
            ? pkg
            : deepest,
        undefined
      );
    if (owner?.status === "complete") {
      owners.add(owner.id);
    }
  }
  return listed.filter((pkg) => owners.has(pkg.id)).map((pkg) => pkg.id);
}

/** Package reports are large, so they are read one at a time, keeping only the symbol ids. */
export async function readSymbols(
  reader: LensReader,
  packages: readonly string[]
): Promise<string[]> {
  const symbols: string[] = [];
  for (const id of packages) {
    const report = await reader.packageReport(id);
    for (const symbol of report.symbols) {
      symbols.push(symbol.id);
    }
  }
  return symbols;
}
