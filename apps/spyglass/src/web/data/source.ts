import type { DatasetReader } from "../../lib/dataset";
import type { DependencyInventory } from "../../lib/dependency-inventory-types";
import type { Domains } from "../../lib/lenses/domains-types";
import type { FileRolesPackage } from "../../lib/lenses/file-roles-types";
import type { ImportTraffic } from "../../lib/lenses/import-traffic-types";
import type { Nesting } from "../../lib/lenses/nesting-types";
import type { PackageSize } from "../../lib/lenses/package-sizes-types";
import type {
  PlacementPackage,
  Placements,
} from "../../lib/lenses/placement-types";
import type { Proximity } from "../../lib/lenses/proximity-types";
import type { ResponsibilityGroupsPackage } from "../../lib/lenses/responsibility-groups-types";
import type {
  SemanticsHistoryEntities,
  SemanticsHistorySnapshotRef,
} from "../../lib/semantics-history-types";
import type {
  DatasetManifest,
  SemanticsDeclaredDependencies,
  SemanticsManifestPackage,
  SemanticsModuleIndexEntry,
} from "../../lib/semantics-types";
import type { PreparedVisualization } from "../../lib/visualization/types";
import type { WorkspaceDependencyEdgeProjection } from "../../lib/workspace-projection-types";

export interface CodexSource {
  dataset: Pick<DatasetManifest, "generatedAt" | "coverage">;
  declaredDependencies: {
    declared: SemanticsDeclaredDependencies;
    package: string;
  }[];
  dependencies: (Pick<WorkspaceDependencyEdgeProjection, "from" | "to"> & {
    concepts: Pick<WorkspaceDependencyEdgeProjection["concepts"], "total">;
    dependency: Pick<
      WorkspaceDependencyEdgeProjection["dependency"],
      "moduleEdges"
    >;
  })[];
  dependencyInventory?: DependencyInventory;
  domains: Domains;
  fileRoles: FileRolesPackage[];
  history?: {
    packages: SemanticsHistoryEntities["packages"];
    snapshots: Pick<
      SemanticsHistorySnapshotRef,
      "commit" | "timestamp" | "status"
    >[];
  };
  importTraffic: ImportTraffic["pairs"];
  layoutEdges?: { source: string; target: string }[];
  modules: Pick<
    SemanticsModuleIndexEntry,
    "id" | "package" | "path" | "fileKind" | "fanIn" | "fanOut" | "mapPosition"
  >[];
  packagePaths: Pick<SemanticsManifestPackage, "id" | "path">[];
  packages: (Pick<PackageSize, "id" | "analyzed" | "layer"> & {
    modules: Pick<PackageSize["modules"], "total">;
  })[];
  placement: {
    packages: Pick<PlacementPackage, "id">[];
    places: Placements["places"];
    policy: Placements["policy"];
  };
  responsibilityGroups: ResponsibilityGroupsPackage[];
  visualization?: PreparedVisualization;
}

export interface LateCodexSource {
  nesting: Pick<Nesting, "folders" | "pathRegions" | "seams">;
  proximity: Pick<Proximity, "apart" | "close" | "packages">;
}

export async function readLateCodexSource(
  reader: DatasetReader
): Promise<LateCodexSource> {
  const [nesting, proximity] = await Promise.all([
    reader.lens("nesting"),
    reader.lens("proximity"),
  ]);
  return {
    nesting: {
      folders: nesting.folders,
      pathRegions: nesting.pathRegions,
      seams: nesting.seams,
    },
    proximity: {
      apart: proximity.apart,
      close: proximity.close,
      packages: proximity.packages,
    },
  };
}

export async function readCodexSource(
  reader: DatasetReader
): Promise<CodexSource> {
  const [
    manifest,
    index,
    graph,
    sizes,
    roles,
    groups,
    placement,
    domains,
    importTraffic,
    history,
  ] = await Promise.all([
    reader.manifest(),
    reader.moduleIndex(),
    reader.dependencyGraph(),
    reader.lens("package-sizes"),
    reader.lens("file-roles"),
    reader.lens("responsibility-groups"),
    reader.lens("placement"),
    reader.lens("domains"),
    reader.lens("import-traffic"),
    reader.history(),
  ]);
  return {
    dataset: manifest,
    declaredDependencies: manifest.packages.map((p) => ({
      declared: p.declaredDependencies,
      package: p.id,
    })),
    dependencies: graph.edges.flatMap((e) =>
      e.kind === "dependency" ? [e] : []
    ),
    dependencyInventory: manifest.files.dependencyInventory
      ? await reader.dependencyInventory()
      : undefined,
    domains: { domains: domains.domains, placements: domains.placements },
    fileRoles: roles.packages,
    history: history && {
      packages: history.entities.packages,
      snapshots: history.manifest.snapshots,
    },
    importTraffic: importTraffic.pairs,
    modules: index.modules,
    visualization: manifest.files.visualization
      ? await reader.visualization()
      : undefined,
    ...(index.modules.some((module) => module.mapPosition === undefined) && {
      layoutEdges: (await reader.moduleEdgeShards()).flatMap((shard) =>
        shard.edges.map(({ source, target }) => ({ source, target }))
      ),
    }),
    packagePaths: manifest.packages.map(({ id, path }) => ({ id, path })),
    packages: sizes.packages,
    placement: {
      packages: placement.packages.map(({ id }) => ({ id })),
      places: placement.places,
      policy: placement.policy,
    },
    responsibilityGroups: groups.packages,
  };
}
