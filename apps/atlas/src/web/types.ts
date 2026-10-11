import type {
  FileRole,
  FileRolesPackage,
} from "../lib/lenses/file-roles-types";
import type { PackageResponsibilityGroups } from "../lib/lenses/responsibility-groups-types";
import type {
  CodexDomains,
  CodexNesting,
  CodexPlacement,
  CodexProximity,
} from "./codex/vocabulary";
import type { FolderCell } from "./folder-sectors";

export interface AtlasSymbol {
  id: string;
  name: string;
}

export interface AtlasFile {
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
  files: AtlasFile[];
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

export interface AtlasRoute {
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

export interface AtlasData {
  coverage: string;
  declaredDependencies?: {
    from: string;
    to: string;
    kind:
      | "dependencies"
      | "devDependencies"
      | "peerDependencies"
      | "optionalDependencies";
  }[];
  /** The `domains` lens: declared domains, and each placed place's domain label by `level:place`. */
  domains: CodexDomains;
  fileEdges: { source: string; target: string }[];
  /** Each island's folder cells from `settleFiles`, by package, in island coordinates, for drawing its folders. */
  folderCells: Record<string, FolderCell>;
  formerPackages?: FormerPackage[];
  generatedAt: string;
  height: number;
  /** The `nesting` lens: the folder tree, path regions, and seams. */
  nesting: CodexNesting;
  /**
   * Each package's dependency layer, for the latitude scale; `null` for a
   * package the graph could not place, which sits at the foundation but
   * stays off the scale. A package missing here is off the scale too.
   */
  packageLayers: Record<string, number | null>;
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
  routes: AtlasRoute[];
  territories: Territory[];
  width: number;
}
