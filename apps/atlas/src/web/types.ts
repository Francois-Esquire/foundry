import type {
  FileRole,
  FileRolesPackage,
} from "../lib/lenses/file-roles-types";
import type { PackageResponsibilityGroups } from "../lib/lenses/responsibility-groups-types";
import type { Neighborhood } from "./neighborhoods";

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
  color: string;
  /** The `file-roles` lens's modules, bound on entering the island; `undefined` without internals. */
  fileRoles: Pick<FileRolesPackage, "modules"> | undefined;
  files: AtlasFile[];
  /** The package's saved high fan-in cutoff; 0 when it has none, as without internals. */
  highFanInCutoff: number;
  hills: Polygon[];
  id: string;
  label: string;
  neighborhoods: Neighborhood[];
  radius: number;
  /** The `responsibility-groups` lens's groups, drawn as districts on entering the island; `undefined` without internals. */
  responsibilityGroups: PackageResponsibilityGroups | undefined;
  shallows: Polygon[];
  x: number;
  y: number;
}

export interface AtlasRoute {
  from: string;
  sharedConcepts: number;
  to: string;
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
  fileEdges: { source: string; target: string }[];
  formerPackages?: FormerPackage[];
  generatedAt: string;
  height: number;
  routes: AtlasRoute[];
  territories: Territory[];
  width: number;
}
