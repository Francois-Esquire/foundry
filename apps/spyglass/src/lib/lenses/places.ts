import type { DomainPlaceKind } from "./domains-types";
import type { LensReader } from "./lens-types";
import { folderOf, WORKSPACE_ROOT } from "./paths";

export interface PlacesSource {
  files: readonly string[];
  packages: readonly string[];
  symbols: readonly string[];
}

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

export function packageRoots(
  listed: ReturnType<LensReader["packages"]>
): string[] {
  return listed
    .filter((pkg) => pkg.status === "complete")
    .map((pkg) => pkg.path)
    .filter((path) => !isWorkspaceRoot(path));
}

function holds(root: string, path: string): boolean {
  return isWorkspaceRoot(root) || path.startsWith(`${root}/`);
}

function rootDepth(root: string): number {
  return isWorkspaceRoot(root) ? 0 : root.split("/").length;
}

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
