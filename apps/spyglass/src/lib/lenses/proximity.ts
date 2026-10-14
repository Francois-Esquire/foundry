import type {
  ResponsibilityModuleEvidence,
  ResponsibilityRegion,
  ResponsibilityRelationship,
} from "../internal-responsibility-types";
import { byId } from "../workspace-projection";
import type { WorkspaceCouplingPair } from "../workspace-types";
import type { Lens } from "./lens-types";
import {
  readPackageInternals,
  rootRelative,
  rootRelativeFolder,
} from "./package-internals";
import { directoryDistance, folderOf } from "./paths";
import type {
  ProximityCoChange,
  ProximityFile,
  ProximityFolder,
} from "./proximity-types";
import { PROXIMITY_SCHEMA_VERSION } from "./proximity-types";

/** A co-change pair, by the fields the lens reads. */
type CoChange = Pick<
  WorkspaceCouplingPair,
  | "coChangeCommits"
  | "context"
  | "id"
  | "jaccard"
  | "left"
  | "right"
  | "scope"
  | "staticPath"
>;

/** One package's responsibilities, by the fields the lens reads; module and directory ids are the package's own. */
export interface ProximitySourcePackage {
  id: string;
  responsibilities: {
    modules: Pick<
      ResponsibilityModuleEvidence,
      "directory" | "module" | "pathAgreesWithRegion" | "region"
    >[];
    regions: (Pick<ResponsibilityRegion, "id" | "modules"> & {
      path: { dominantDirectory: { id: string } };
    })[];
    relationships: Pick<ResponsibilityRelationship, "from" | "to">[];
  };
  root: string;
}

/** Every dataset field the lens reads. */
export interface ProximitySource {
  /** The workspace report's co-change pairs, as stored: already past `lib`'s coupling gates. */
  coChanges: CoChange[];
  missing: string[];
  packages: ProximitySourcePackage[];
}

/** Only pairs of source files, as `lib`'s own uses of co-change read them (`couplingContexts`). */
function sourcePairs(coChanges: readonly CoChange[]): CoChange[] {
  return coChanges.filter((pair) => pair.context === "source-source");
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\n${b}` : `${b}\n${a}`;
}

/** Responsibility pairs something relates: a relationship either way, or a co-change between their files. */
function relatedPairs(
  pkg: ProximitySourcePackage,
  coChanges: readonly CoChange[]
): Set<string> {
  const related = new Set(
    pkg.responsibilities.relationships.map(({ from, to }) => pairKey(from, to))
  );
  const regionOf = new Map<string, string>();
  for (const region of pkg.responsibilities.regions) {
    for (const module of region.modules) {
      regionOf.set(rootRelative(pkg.root, module), region.id);
    }
  }
  for (const pair of coChanges) {
    const left = regionOf.get(pair.left);
    const right = regionOf.get(pair.right);
    if (left !== undefined && right !== undefined && left !== right) {
      related.add(pairKey(left, right));
    }
  }
  return related;
}

/** The connected components of `nodes` under `related`, each sorted, by first id. */
function components(
  nodes: readonly string[],
  related: ReadonlySet<string>
): string[][] {
  const parent = new Map(nodes.map((node) => [node, node]));
  const find = (node: string): string => {
    let current = node;
    while (parent.get(current) !== current) {
      current = parent.get(current) ?? current;
    }
    return current;
  };
  for (const [index, a] of nodes.entries()) {
    for (const b of nodes.slice(index + 1)) {
      if (related.has(pairKey(a, b))) {
        parent.set(find(a), find(b));
      }
    }
  }
  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const root = find(node);
    groups.set(root, [...(groups.get(root) ?? []), node]);
  }
  return [...groups.values()]
    .map((group) => group.sort(byId))
    .sort((a, b) => byId(a[0] ?? "", b[0] ?? ""));
}

/**
 * The package's folders whose files directly in them fall into two or more
 * unrelated groups; each group names its files that are also apart from
 * their responsibility's folder.
 */
function closeFolders(
  pkg: ProximitySourcePackage,
  related: ReadonlySet<string>,
  apart: ReadonlySet<string>
): ProximityFolder[] {
  const byFolder = new Map<
    string,
    { files: Map<string, string[]>; unresolved: number }
  >();
  for (const module of pkg.responsibilities.modules) {
    const folder = rootRelativeFolder(pkg.root, module.directory);
    const entry = byFolder.get(folder) ?? { files: new Map(), unresolved: 0 };
    byFolder.set(folder, entry);
    if (module.region === undefined) {
      entry.unresolved += 1;
      continue;
    }
    const files = entry.files.get(module.region) ?? [];
    files.push(rootRelative(pkg.root, module.module));
    entry.files.set(module.region, files);
  }
  const folders: ProximityFolder[] = [];
  for (const [folder, { files, unresolved }] of byFolder) {
    const groups = components([...files.keys()], related);
    if (groups.length < 2) {
      continue;
    }
    folders.push({
      folder,
      groups: groups.map((responsibilities) => {
        const members = responsibilities
          .flatMap((region) => files.get(region) ?? [])
          .sort(byId);
        return {
          apart: members.filter((file) => apart.has(file)),
          files: members,
          responsibilities,
        };
      }),
      package: pkg.id,
      unresolved,
    });
  }
  return folders;
}

/** The package's files whose responsibility's dominant folder is another folder. */
function filesApart(pkg: ProximitySourcePackage): ProximityFile[] {
  const dominant = new Map(
    pkg.responsibilities.regions.map((region) => [
      region.id,
      rootRelativeFolder(pkg.root, region.path.dominantDirectory.id),
    ])
  );
  const files: ProximityFile[] = [];
  for (const module of pkg.responsibilities.modules) {
    const responsibilityFolder =
      module.region === undefined ? undefined : dominant.get(module.region);
    if (
      module.pathAgreesWithRegion !== false ||
      module.region === undefined ||
      responsibilityFolder === undefined
    ) {
      continue;
    }
    const folder = rootRelativeFolder(pkg.root, module.directory);
    files.push({
      distance: directoryDistance(folder, responsibilityFolder),
      file: rootRelative(pkg.root, module.module),
      folder,
      package: pkg.id,
      responsibility: module.region,
      responsibilityFolder,
    });
  }
  return files;
}

/** Co-changing source files from different folders, with the steps between them. */
function coChangesApart(coChanges: readonly CoChange[]): ProximityCoChange[] {
  return coChanges.flatMap((pair) => {
    const distance = directoryDistance(
      folderOf(pair.left),
      folderOf(pair.right)
    );
    return distance === 0
      ? []
      : [
          {
            coChangeCommits: pair.coChangeCommits,
            distance,
            id: pair.id,
            jaccard: pair.jaccard,
            left: pair.left,
            right: pair.right,
            scope: pair.scope,
            staticPath: pair.staticPath,
          },
        ];
  });
}

/**
 * What sits close without being related, and what is related without
 * sitting close. Close is a folder, the file system's own grouping; related
 * is the responsibilities' own evidence: one responsibility, a relationship
 * between two, or a co-change between their source files. A file that no
 * responsibility holds is left out of relatedness and counted. A file apart
 * is the responsibilities' own `pathAgreesWithRegion` judgment, copied; the
 * same comparison between path regions, `responsibilities.pathSeams`, stays
 * in the internals, where a reader finds it per seam. Responsibilities are
 * read from the internals, not through the `responsibility-groups` lens,
 * whose groups carry neither the modules, the relationships, nor the
 * dominant folders this needs, and come from a modularity merge rather than
 * the analysis's evidence.
 */
export const proximityLens: Lens<"proximity", ProximitySource> = {
  derive: ({ coChanges, missing, packages }) => {
    const pairs = sourcePairs(coChanges);
    const files = packages
      .flatMap(filesApart)
      .sort((a, b) => byId(a.file, b.file));
    const apart = new Set(files.map((file) => file.file));
    return {
      apart: {
        coChanges: coChangesApart(pairs).sort((a, b) => byId(a.id, b.id)),
        files,
      },
      close: packages
        .flatMap((pkg) => closeFolders(pkg, relatedPairs(pkg, pairs), apart))
        .sort((a, b) => byId(a.folder, b.folder)),
      missing,
      packages: packages
        .map((pkg) => ({
          id: pkg.id,
          unresolved: pkg.responsibilities.modules.filter(
            (module) => module.region === undefined
          ).length,
        }))
        .sort((a, b) => byId(a.id, b.id)),
    };
  },
  id: "proximity",
  read: async (reader) => {
    const [workspace, { missing, packages }] = await Promise.all([
      reader.workspaceReport(),
      readPackageInternals(reader),
    ]);
    return {
      coChanges: workspace.evolution.couplings.map(
        ({
          coChangeCommits,
          context,
          id,
          jaccard,
          left,
          right,
          scope,
          staticPath,
        }) => ({
          coChangeCommits,
          context,
          id,
          jaccard,
          left,
          right,
          scope,
          staticPath,
        })
      ),
      missing,
      packages: packages.map(({ id, internals, root }) => {
        const { modules, regions, relationships } = internals.responsibilities;
        return {
          id,
          responsibilities: {
            modules: modules.map(
              ({ directory, module, pathAgreesWithRegion, region }) => ({
                directory,
                module,
                ...(pathAgreesWithRegion !== undefined && {
                  pathAgreesWithRegion,
                }),
                ...(region !== undefined && { region }),
              })
            ),
            regions: regions.map(({ id: region, modules: members, path }) => ({
              id: region,
              modules: [...members],
              path: { dominantDirectory: { id: path.dominantDirectory.id } },
            })),
            relationships: relationships.map(({ from, to }) => ({ from, to })),
          },
          root,
        };
      }),
    };
  },
  schemaVersion: PROXIMITY_SCHEMA_VERSION,
  settings: [],
};
