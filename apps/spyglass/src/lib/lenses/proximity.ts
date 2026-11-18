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

export interface ProximitySource {
  coChanges: CoChange[];
  missing: string[];
  packages: ProximitySourcePackage[];
}

function sourcePairs(coChanges: readonly CoChange[]): CoChange[] {
  return coChanges.filter((pair) => pair.context === "source-source");
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\n${b}` : `${b}\n${a}`;
}

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
