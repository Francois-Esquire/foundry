import type { SemanticsModuleIndexEntry } from "../semantics-types";
import { byId } from "../workspace-projection";
import type { WorkspaceGraphProjectionNode } from "../workspace-projection-types";
import type { Lens } from "./lens-types";
import type { PackageSizeKind } from "./package-sizes-types";
import { PACKAGE_SIZES_SCHEMA_VERSION } from "./package-sizes-types";

/** Every dataset field the lens reads. */
export interface PackageSizesSource {
  modules: Pick<SemanticsModuleIndexEntry, "package" | "fileKind">[];
  nodes: Pick<WorkspaceGraphProjectionNode, "id" | "analyzed" | "layer">[];
}

function noFiles(): Record<PackageSizeKind, number> {
  return { config: 0, other: 0, source: 0, story: 0, test: 0, unknown: 0 };
}

/**
 * Each package's place in the dependency graph joined to its file count by
 * kind. It reads the graph projection and the module index, which every
 * dataset has.
 */
export const packageSizesLens: Lens<"package-sizes", PackageSizesSource> = {
  derive: ({ modules, nodes }) => {
    const byPackage = new Map<string, Record<PackageSizeKind, number>>();
    for (const module of modules) {
      let kinds = byPackage.get(module.package);
      if (kinds === undefined) {
        kinds = noFiles();
        byPackage.set(module.package, kinds);
      }
      kinds[module.fileKind ?? "unknown"] += 1;
    }
    return {
      packages: [...nodes]
        .sort((a, b) => byId(a.id, b.id))
        .map((node) => {
          const byKind = byPackage.get(node.id) ?? noFiles();
          return {
            analyzed: node.analyzed,
            id: node.id,
            layer: node.layer,
            modules: {
              byKind,
              total: Object.values(byKind).reduce((sum, n) => sum + n, 0),
            },
          };
        }),
    };
  },
  id: "package-sizes",
  read: async (reader) => {
    const [graph, index] = await Promise.all([
      reader.dependencyGraph(),
      reader.moduleIndex(),
    ]);
    return { modules: index.modules, nodes: graph.nodes };
  },
  schemaVersion: PACKAGE_SIZES_SCHEMA_VERSION,
  settings: [],
};
