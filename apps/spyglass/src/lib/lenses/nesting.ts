import type {
  InternalDirectoryNode,
  InternalRegionNode,
  InternalSeam,
} from "../internal-topology-types";
import type { SemanticsModuleIndexEntry } from "../semantics-types";
import { byId } from "../workspace-projection";
import type { Lens } from "./lens-types";
import type {
  NestingFolder,
  NestingPathRegion,
  NestingSeam,
} from "./nesting-types";
import { NESTING_SCHEMA_VERSION } from "./nesting-types";
import { readPackageInternals, rootRelativeFolder } from "./package-internals";
import { folderOf, WORKSPACE_ROOT } from "./paths";

export interface NestingSourceInternals {
  id: string;
  root: string;
  topology: {
    directories: Pick<InternalDirectoryNode, "id" | "region">[];
    regions: Pick<InternalRegionNode, "id" | "modules" | "primaryModules">[];
    seams: Pick<
      InternalSeam,
      "from" | "to" | "moduleEdges" | "importSites" | "symbolFlow"
    >[];
  };
}

export interface NestingSource {
  internals: NestingSourceInternals[];
  missing: string[];
  modules: Pick<SemanticsModuleIndexEntry, "id">[];
  packages: { id: string; path: string }[];
}

function rootFolder(path: string): string {
  return path === "" ? WORKSPACE_ROOT : path;
}

function chain(folder: string, rootIsPackage: boolean): string[] {
  const folders: string[] = [];
  let current = folder;
  while (current !== WORKSPACE_ROOT) {
    folders.push(current);
    current = folderOf(current);
  }
  if (rootIsPackage) {
    folders.push(WORKSPACE_ROOT);
  }
  return folders;
}

function deriveFolders(
  modules: NestingSource["modules"],
  packages: NestingSource["packages"]
): Map<string, NestingFolder> {
  const roots = new Map(packages.map((pkg) => [rootFolder(pkg.path), pkg.id]));
  const rootIsPackage = roots.has(WORKSPACE_ROOT);
  const folders = new Map<string, NestingFolder>();
  const foldersFrom = (start: string): NestingFolder[] =>
    chain(start, rootIsPackage).map((id) => {
      const folder = folders.get(id) ?? newFolder(id, roots, rootIsPackage);
      folders.set(id, folder);
      return folder;
    });
  const countFile = (file: string) => {
    const [own, ...above] = foldersFrom(folderOf(file));
    if (own === undefined) {
      return;
    }
    own.fileCounts.direct += 1;
    for (const folder of [own, ...above]) {
      folder.fileCounts.descendant += 1;
    }
  };
  for (const module of modules) {
    countFile(module.id);
  }
  for (const root of roots.keys()) {
    foldersFrom(root);
  }
  return folders;
}

function newFolder(
  id: string,
  roots: ReadonlyMap<string, string>,
  rootIsPackage: boolean
): NestingFolder {
  const above = chain(id, rootIsPackage);
  const [, parent] = above;
  const owner = above.find((folder) => roots.has(folder));
  const pkg = owner === undefined ? undefined : roots.get(owner);
  return {
    fileCounts: { descendant: 0, direct: 0 },
    id,
    ...(pkg !== undefined && { package: pkg }),
    packageRoot: roots.has(id),
    ...(parent !== undefined && { parent }),
  };
}

function pathRegionsByPackage(
  internals: readonly NestingSourceInternals[]
): Map<string, Map<string, string>> {
  return new Map(
    internals.map((pkg) => [
      pkg.id,
      new Map(
        pkg.topology.directories.map((directory) => [
          rootRelativeFolder(pkg.root, directory.id),
          directory.region,
        ])
      ),
    ])
  );
}

export const nestingLens: Lens<"nesting", NestingSource> = {
  derive: ({ internals, missing, modules, packages }) => {
    const folders = deriveFolders(modules, packages);
    const regions = pathRegionsByPackage(internals);
    const pathRegions: NestingPathRegion[] = [];
    const seams: NestingSeam[] = [];
    for (const pkg of internals) {
      for (const region of pkg.topology.regions) {
        pathRegions.push({
          files: region.modules,
          id: region.id,
          package: pkg.id,
          primaryFiles: region.primaryModules,
        });
      }
      for (const seam of pkg.topology.seams) {
        seams.push({
          from: seam.from,
          importSites: seam.importSites,
          moduleEdges: seam.moduleEdges,
          package: pkg.id,
          symbolFlow: seam.symbolFlow,
          to: seam.to,
        });
      }
    }
    return {
      folders: [...folders.values()]
        .map((folder) => {
          const pathRegion =
            folder.package === undefined
              ? undefined
              : regions.get(folder.package)?.get(folder.id);
          return pathRegion === undefined ? folder : { ...folder, pathRegion };
        })
        .sort((a, b) => byId(a.id, b.id)),
      missing,
      pathRegions: pathRegions.sort(
        (a, b) => byId(a.package, b.package) || byId(a.id, b.id)
      ),
      seams: seams.sort(
        (a, b) =>
          byId(a.package, b.package) || byId(a.from, b.from) || byId(a.to, b.to)
      ),
    };
  },
  id: "nesting",
  read: async (reader) => {
    const [index, { missing, packages }] = await Promise.all([
      reader.moduleIndex(),
      readPackageInternals(reader),
    ]);
    return {
      internals: packages.map(({ id, internals, root }) => {
        const { directories, regions, seams } = internals.topology;
        return {
          id,
          root,
          topology: {
            directories: directories.map(({ id: directory, region }) => ({
              id: directory,
              region,
            })),
            regions: regions.map(({ id: region, modules, primaryModules }) => ({
              id: region,
              modules,
              primaryModules,
            })),
            seams: seams.map(
              ({ from, importSites, moduleEdges, symbolFlow, to }) => ({
                from,
                importSites,
                moduleEdges,
                symbolFlow,
                to,
              })
            ),
          },
        };
      }),
      missing,
      modules: index.modules.map(({ id }) => ({ id })),
      packages: reader
        .packages()
        .filter((pkg) => pkg.status === "complete")
        .map(({ id, path }) => ({ id, path })),
    };
  },
  schemaVersion: NESTING_SCHEMA_VERSION,
  settings: [],
};
