import type { Crossing } from "../../lib/collection-types";
import type { DatasetTransport } from "../../lib/dataset";
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

  fileRole?: FileRole;

  highFanIn: boolean;
  id: string;

  incoming: number;

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

  fileRoles: Pick<FileRolesPackage, "modules"> | undefined;
  files: SpyglassFile[];

  folder: string;

  highFanInCutoff: number;
  hills: Polygon[];
  id: string;
  label: string;
  radius: number;

  responsibilityGroups: PackageResponsibilityGroups | undefined;
  shallows: Polygon[];
  x: number;
  y: number;
}

interface SpyglassRoute {
  consumerFiles: readonly string[];
  from: string;
  sharedConcepts: number;

  supplierFiles: readonly string[];
  to: string;

  weight: number;
}

type SpyglassFoundation = DependencyFoundation;

export interface DatasetRef {
  generatedAt: string;
  root: string;
  transport?: DatasetTransport;
}

export interface FrameReadings {
  domains: CodexDomains;

  nesting: CodexNesting;

  placement: {
    dominantShare: number;
    labelled: readonly string[];
    places: Record<string, CodexPlacement>;
  };

  proximity: CodexProximity;
}

export interface SpyglassFrame {
  dataset: DatasetRef;
  id: string;
  label: string;
  readings: FrameReadings;
  territories: readonly string[];

  visualization: PreparedVisualization;
}

export interface SpyglassData {
  coverage: string;

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

  frames: SpyglassFrame[];
  height: number;

  internalFoundations?: InternalFoundation[];

  ownDependencies?: OwnDependency[];

  packageLayers: Record<string, number | null>;
  routes: SpyglassRoute[];
  territories: Territory[];
  width: number;
}

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

export function islandsByFrame(
  data: Pick<SpyglassData, "frames" | "territories">
): Territory[][] {
  return data.frames.map((frame) =>
    data.territories.filter((territory) =>
      frame.territories.includes(territory.id)
    )
  );
}
