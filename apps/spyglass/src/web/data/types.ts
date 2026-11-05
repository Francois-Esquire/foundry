import type { Crossing } from "../../lib/collection-types";
import type {
  FileRole,
  FileRolesPackage,
} from "../../lib/lenses/file-roles-types";
import type { PackageResponsibilityGroups } from "../../lib/lenses/responsibility-groups-types";
import type { OwnDependency } from "../../lib/visualization/sea-stacks";
import type {
  DependencyFoundation,
  FoundationGroup,
  InternalFoundation,
  PreparedVisualization,
} from "../../lib/visualization/types";
import type {
  CodexDomains,
  CodexNesting,
  CodexPlacement,
  CodexProximity,
} from "./vocabulary";

export interface SpyglassFile {
  directory: string;
  /** Its file role from the `file-roles` lens, attached only where the district arrangement draws role marks. */
  fileRole?: FileRole;
  /** Whether its package's topology calls it high fan-in; such a file raises a summit. */
  highFanIn: boolean;
  id: string;
  /** Import edges ending here, within and across packages. */
  incoming: number;
  /** Source modules of its own package importing it, from the `file-roles` lens; 0 without internals. */
  internalFanIn: number;
  kind: string;
  outgoing: number;
  path: string;
  x: number;
  y: number;
}

type Polygon = [number, number][][];

export interface Territory {
  analyzed: boolean;
  coast: Polygon[];
  /** The `file-roles` lens's modules, bound on entering the island; `undefined` without internals. */
  fileRoles: Pick<FileRolesPackage, "modules"> | undefined;
  files: SpyglassFile[];
  /** The package's folder, its workspace-relative path from the manifest; it orders the island's row. */
  folder: string;
  /** The package's saved high fan-in cutoff; 0 when it has none, as without internals. */
  highFanInCutoff: number;
  hills: Polygon[];
  id: string;
  label: string;
  radius: number;
  /** The `responsibility-groups` lens's groups, drawn as districts on entering the island; `undefined` without internals. */
  responsibilityGroups: PackageResponsibilityGroups | undefined;
  shallows: Polygon[];
  x: number;
  y: number;
}

interface SpyglassRoute {
  /** Files of `from` that import a file of `to`, sorted. */
  consumerFiles: readonly string[];
  from: string;
  sharedConcepts: number;
  /** Files of `to` that a file of `from` imports, sorted. */
  supplierFiles: readonly string[];
  to: string;
  /** Module import edges from `from` to `to`, from the dependency graph. */
  weight: number;
}

type SpyglassFoundation = DependencyFoundation;

/**
 * Where one workspace's dataset is, and the one it is: its directory under
 * the viewer's data root (`""` for a single workspace's, `<id>/` for a
 * collection's), and the manifest's `generatedAt`, which every later read
 * of it is pinned to.
 */
export interface DatasetRef {
  generatedAt: string;
  root: string;
}

/**
 * One workspace's readings, its lenses as the map reads them, keyed by its
 * own bare paths and package ids, as its dataset holds them.
 */
export interface FrameReadings {
  /** The `domains` lens: declared domains, and each placed place's domain label by `level:place`. */
  domains: CodexDomains;
  /** The `nesting` lens: the folder tree, path regions, and seams. */
  nesting: CodexNesting;
  /**
   * The `placement` lens: every place a module of another package uses, by
   * `placementKey` (`level:place`), and the packages it labelled. A place of
   * a labelled package that is absent is used by no other package; a
   * package not labelled has no internals, and its use is unknown.
   */
  placement: {
    /** The share of a place's consumer modules at which one package holds its use. */
    dominantShare: number;
    labelled: readonly string[];
    places: Record<string, CodexPlacement>;
  };
  /** The `proximity` lens: close but unrelated folders, and related but apart files. */
  proximity: CodexProximity;
}

/**
 * One workspace on the map: its id, its label, its dataset, the islands it
 * holds (by `Territory.id`), and its readings. A single workspace is one
 * frame.
 */
export interface SpyglassFrame {
  dataset: DatasetRef;
  id: string;
  label: string;
  readings: FrameReadings;
  territories: readonly string[];
  /**
   * The map the frame's territories were laid out from: the dataset's saved
   * `map.json` when it still fits, else the one laid out again in the
   * browser. The Islands chart is made from it, so the chart and the labels
   * share coordinates.
   */
  visualization: PreparedVisualization;
}

export interface SpyglassData {
  coverage: string;
  /**
   * In a collection, the declared dependencies of a package in one workspace
   * on a package of another, from the collection manifest, by qualified id;
   * absent for a single workspace. Not routes: the map draws one line per
   * pair of packages (`crossingPairs`), and Place lists them.
   */
  crossings?: readonly Crossing[];
  declaredDependencies?: {
    from: string;
    to: string;
    kind:
      | "dependencies"
      | "devDependencies"
      | "peerDependencies"
      | "optionalDependencies";
  }[];
  dependencyCoverage?: "complete" | "partial" | "unavailable";
  fileEdges: { source: string; target: string }[];
  foundationGroups?: FoundationGroup[];
  foundations?: SpyglassFoundation[];
  /** Each workspace on the map, with its dataset and readings; one for a single workspace. */
  frames: SpyglassFrame[];
  height: number;
  /** Workspace packages others rely on: terrain structure, never layout. */
  internalFoundations?: InternalFoundation[];
  /** Runtime third-party dependencies only one package relies on: its sea stacks. */
  ownDependencies?: OwnDependency[];
  /**
   * Each package's dependency layer, for the latitude scale; `null` for a
   * package the graph could not place, which sits at the foundation but
   * stays off the scale. A package missing here is off the scale too.
   */
  packageLayers: Record<string, number | null>;
  routes: SpyglassRoute[];
  territories: Territory[];
  width: number;
}

/**
 * The frame that holds an island. A single workspace's one frame holds
 * every island of its spyglass; in a collection an island in no frame is a
 * mistake, and answering another frame's readings would hide it.
 */
export function frameOf(
  spyglass: Pick<SpyglassData, "frames">,
  territoryId: string
): SpyglassFrame {
  const frame =
    spyglass.frames.find((item) => item.territories.includes(territoryId)) ??
    (spyglass.frames.length === 1 ? spyglass.frames[0] : undefined);
  if (!frame) {
    throw new Error(
      `No frame of the spyglass holds the island ${territoryId}.`
    );
  }
  return frame;
}

/** Each frame's islands, in the spyglass's order, by frame. */
export function islandsByFrame(
  data: Pick<SpyglassData, "frames" | "territories">
): Territory[][] {
  return data.frames.map((frame) =>
    data.territories.filter((territory) =>
      frame.territories.includes(territory.id)
    )
  );
}
