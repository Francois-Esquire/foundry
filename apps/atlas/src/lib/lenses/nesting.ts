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

/** The workspace root, as a folder id. */
const WORKSPACE_ROOT = ".";

/** One package's internals, by the fields the lens reads; directory ids are the package's own. */
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

/** Every dataset field the lens reads. */
export interface NestingSource {
  internals: NestingSourceInternals[];
  missing: string[];
  modules: Pick<SemanticsModuleIndexEntry, "id">[];
  /** The complete packages, by manifest id and root path. */
  packages: { id: string; path: string }[];
}

/** A package root as a folder id: `.` for the workspace root. */
function rootFolder(path: string): string {
  return path === "" ? WORKSPACE_ROOT : path;
}

/** The folder holding a file or folder; the workspace root for a top-level one. */
function folderAbove(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? WORKSPACE_ROOT : path.slice(0, slash);
}

/**
 * A folder and every folder above it, nearest first, ending at the top of
 * the workspace: the workspace root only when a package lives there, since
 * otherwise no file of the index sits in it.
 */
function chain(folder: string, rootIsPackage: boolean): string[] {
  const folders: string[] = [];
  let current = folder;
  while (current !== WORKSPACE_ROOT) {
    folders.push(current);
    current = folderAbove(current);
  }
  if (rootIsPackage) {
    folders.push(WORKSPACE_ROOT);
  }
  return folders;
}

/** The tree: each folder's file counts, parent, and owning package. */
function deriveFolders(
  modules: NestingSource["modules"],
  packages: NestingSource["packages"]
): Map<string, NestingFolder> {
  const roots = new Map(packages.map((pkg) => [rootFolder(pkg.path), pkg.id]));
  const rootIsPackage = roots.has(WORKSPACE_ROOT);
  const folders = new Map<string, NestingFolder>();
  /** Every folder from `start` to the top, nearest first, each created when first reached. */
  const foldersFrom = (start: string): NestingFolder[] =>
    chain(start, rootIsPackage).map((id) => {
      const folder = folders.get(id) ?? newFolder(id, roots, rootIsPackage);
      folders.set(id, folder);
      return folder;
    });
  /** Counts a file directly in its own folder and below every folder above it. */
  const countFile = (file: string) => {
    const [own, ...above] = foldersFrom(folderAbove(file));
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
  // A package's root is a folder even when no file is counted in it.
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

/**
 * Each package's folders, root-relative, with their path regions from its
 * own internal topology. A folder takes its region only from the package
 * that owns it, so a topology that also lists a nested package's folders
 * never decides theirs.
 */
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

/**
 * How the workspace is nested: one tree of folders across every package,
 * from the folders above the package roots down to each file's folder,
 * built from the module index so that every analyzed package is in it; and,
 * for the packages with internals, each folder's path region, the path
 * regions, and the seams between them, copied from the internal topology.
 * Nothing is measured again.
 */
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
