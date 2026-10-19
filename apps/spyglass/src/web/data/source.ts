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

/** Every source field the codex reads. Resolvers see nothing else. */
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
  /** The `placement` lens: where each place is used against where it lives, and the packages it labelled. */
  /** The `domains` lens: the declared domains, and the domain label of every placed place in one. */
  domains: Domains;
  /** The `file-roles` lens: fan-in raises summits; roles are bound on entering an island. */
  fileRoles: FileRolesPackage[];
  history?: {
    packages: SemanticsHistoryEntities["packages"];
    snapshots: Pick<
      SemanticsHistorySnapshotRef,
      "commit" | "timestamp" | "status"
    >[];
  };
  /** The `import-traffic` lens: each package pair's endpoint files, for harbors, roads and Trading partners. */
  importTraffic: ImportTraffic["pairs"];
  /** Needed only for older datasets without scan-time map positions. */
  layoutEdges?: { source: string; target: string }[];
  /** The module index includes saved file positions and import counts for the first frame. */
  modules: Pick<
    SemanticsModuleIndexEntry,
    "id" | "package" | "path" | "fileKind" | "fanIn" | "fanOut" | "mapPosition"
  >[];
  /** Each package's workspace-relative folder, from the manifest. */
  packagePaths: Pick<SemanticsManifestPackage, "id" | "path">[];
  /** The `package-sizes` lens, sorted by id. */
  packages: (Pick<PackageSize, "id" | "analyzed" | "layer"> & {
    modules: Pick<PackageSize["modules"], "total">;
  })[];
  placement: {
    packages: Pick<PlacementPackage, "id">[];
    places: Placements["places"];
    policy: Placements["policy"];
  };
  /** The `responsibility-groups` lens, drawn as districts on entering an island. */
  responsibilityGroups: ResponsibilityGroupsPackage[];
  visualization?: PreparedVisualization;
}

/**
 * The fields read after the layout (`readLateCodexSource`): nothing at
 * overview draws them, so the first layout does not wait for them.
 */
export interface LateCodexSource {
  /** The `nesting` lens: one folder tree, with each package's path regions and the seams between them. */
  nesting: Pick<Nesting, "folders" | "pathRegions" | "seams">;
  /** The `proximity` lens: what sits close without being related, and what is related without sitting close. */
  proximity: Pick<Proximity, "apart" | "close" | "packages">;
}

/** The late fields, read through one dataset reader, pinned to the load's manifest. */
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

/** The codex's fields for the first layout, read through one dataset reader. */
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
