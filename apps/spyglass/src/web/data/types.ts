import type { Crossing } from "../../lib/collection-types";
import type {
  FileRole,
  FileRolesPackage,
} from "../../lib/lenses/file-roles-types";
import type { PackageResponsibilityGroups } from "../../lib/lenses/responsibility-groups-types";
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

export type Polygon = [number, number][][];

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

export interface SpyglassRoute {
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

export interface FormerPackage {
  id: string;
  label: string;
  lastObserved: string;
  x: number;
  y: number;
}

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
  fileEdges: { source: string; target: string }[];
  /** Each island's folder cells from `settleFiles`, by package, in island coordinates, for drawing its folders. */
  folderCells: Record<string, FolderCell>;
  formerPackages?: FormerPackage[];
  /** Each workspace on the map, with its dataset and readings; one for a single workspace. */
  frames: SpyglassFrame[];
  height: number;
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

/**
 * What a reader calls an island off the map: its name, and in a collection
 * its frame's label after it, "shared · platform", since two workspaces can
 * each hold a package of one name. On the map, the frame's label sits above
 * the frame instead.
 */
export function islandName(
  spyglass: Pick<SpyglassData, "frames">,
  territory: Pick<Territory, "id" | "label">
): string {
  return spyglass.frames.length > 1
    ? `${territory.label} · ${frameOf(spyglass, territory.id).label}`
    : territory.label;
}

/**
 * A package's id on the map, from its bare id in a frame's readings: the
 * qualified id `<frame>:<package>` in a collection's frame, the bare id in
 * a single workspace's, whose frame id is empty.
 */
export function qualifiedIn(
  frame: Pick<SpyglassFrame, "id">,
  id: string
): string {
  return frame.id ? `${frame.id}:${id}` : id;
}

/** A package's bare id in its workspace's dataset, from its id on the map: `qualifiedIn` undone. */
function bareIn(frame: Pick<SpyglassFrame, "id">, id: string): string {
  const prefix = frame.id ? `${frame.id}:` : "";
  return prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/** Where an island's own evidence is read from: its workspace's dataset, and its bare package id there. */
export interface IslandSource {
  dataset: DatasetRef;
  package: string;
}

/** An island's source, through the frame that holds it. */
export function islandSource(
  spyglass: Pick<SpyglassData, "frames">,
  territoryId: string
): IslandSource {
  const frame = frameOf(spyglass, territoryId);
  return { dataset: frame.dataset, package: bareIn(frame, territoryId) };
}

/** One string per island source, for comparing reads and keying effects. */
export function sourceKey(source: IslandSource): string {
  return JSON.stringify([
    source.dataset.root,
    source.dataset.generatedAt,
    source.package,
  ]);
}

/** A workspace of a collection, as its frame names it. */
export interface FrameName {
  id: string;
  label: string;
}

/**
 * One workspace's spyglass, laid out with its bare ids, made one frame of a
 * collection: every package id qualified, `<workspace id>:<package>`, and
 * every file id `<workspace id>:<path>`, in the islands, their cells and
 * layers, the routes and their endpoint files, the import edges, the
 * declared dependencies and the former packages. Paths, folders and the
 * frame's readings stay bare, as its dataset holds them: they are read
 * through the frame. The layout is not touched, so it is the one the
 * workspace's bare ids seeded.
 */
export function qualifySpyglassData(
  data: SpyglassData,
  name: FrameName
): SpyglassData {
  const island = (id: string) => `${name.id}:${id}`;
  const file = (id: string) => `${name.id}:${id}`;
  const [frame] = data.frames;
  if (!frame || data.frames.length > 1) {
    throw new Error("Only a single workspace's spyglass is qualified.");
  }
  return {
    ...data,
    declaredDependencies: data.declaredDependencies?.map((dependency) => ({
      ...dependency,
      from: island(dependency.from),
      to: island(dependency.to),
    })),
    fileEdges: data.fileEdges.map((edge) => ({
      source: file(edge.source),
      target: file(edge.target),
    })),
    folderCells: Object.fromEntries(
      Object.entries(data.folderCells).map(([id, cell]) => [island(id), cell])
    ),
    ...(data.formerPackages && {
      formerPackages: data.formerPackages.map((former) => ({
        ...former,
        id: island(former.id),
      })),
    }),
    frames: [
      {
        ...frame,
        id: name.id,
        label: name.label,
        territories: frame.territories.map(island),
      },
    ],
    packageLayers: Object.fromEntries(
      Object.entries(data.packageLayers).map(([id, layer]) => [
        island(id),
        layer,
      ])
    ),
    routes: data.routes.map((route) => ({
      ...route,
      consumerFiles: route.consumerFiles.map(file),
      from: island(route.from),
      supplierFiles: route.supplierFiles.map(file),
      to: island(route.to),
    })),
    territories: data.territories.map((territory) => ({
      ...territory,
      files: territory.files.map((item) => ({ ...item, id: file(item.id) })),
      id: island(territory.id),
    })),
  };
}

export interface Site {
  x: number;
  y: number;
}

/**
 * A cut between the two sides of a split: the line `axis` = `at`, from
 * `from` to `to` along the other axis, across the whole of the rectangle the
 * split divided, so a cut meets the cuts around it at T-junctions. It sits
 * mid-gutter, and no site crosses it afterwards.
 */
export interface CellSplit {
  at: number;
  axis: "x" | "y";
  from: number;
  to: number;
}

/** A region of the island a split divides, in island units: the island's box, then each side of each cut. */
export interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * A folder's cell: its sites, those of its own files and of every folder
 * below it; the cuts made between its own files and its subfolders, in the
 * order made; its subfolders' cells, by name; and its region, the rectangle
 * its parent's cuts left it, which the coast trims to its land. The
 * package's folder is the root cell, `folder` "", its region the island's
 * box. Cells of one parent share the coordinate of the cut between them
 * exactly, so their regions meet edge to edge.
 */
export interface FolderCell {
  folder: string;
  folders: FolderCell[];
  region: Readonly<Rect>;
  sites: readonly Readonly<Site>[];
  /** Cluster geography has no rectangular partition boundaries. */
  spatial?: "cluster";
  splits: CellSplit[];
}
