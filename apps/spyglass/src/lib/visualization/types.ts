import type { DependencyInventory } from "../dependency-inventory-types";

export type Polygon = [number, number][][];

/** One island's shortest runtime path to a third-party foundation. */
export interface FoundationMember {
  direct: boolean;
  distance: number;
  territoryId: string;
  /** Direct static imports only. Absence means unknown or indirect reliance. */
  usage?: {
    importingFiles: string[];
    runtimeFiles: string[];
    typeOnlyFiles: string[];
  };
  /** Distance attenuation with bounded usage refinement, independent of visibility. */
  weight: number;
}

/** A dependency's shared substrate, derived from the same members used by layout. */
export interface DependencyFoundation {
  id: string;
  lobes: {
    radius: number;
    territoryId: string;
    weight: number;
    x: number;
    y: number;
  }[];
  members: FoundationMember[];
  name: string;
  /** Distinct consuming islands; visual prominence is not attraction strength. */
  prominence: number;
  /** Concrete resolved versions only; declared ranges are not installed versions. */
  versions: string[];
  x: number;
  y: number;
}

export interface IslandGeometry {
  coast: Polygon[];
  hills: Polygon[];
  id: string;
  radius: number;
  shallows: Polygon[];
  x: number;
  y: number;
}

/** One shared membership set, with all its dependency identities retained. */
export interface FoundationGroup {
  dependencyIds: string[];
  footprint: Polygon[];
  id: string;
  memberIds: string[];
  /** Nested contour planes, from deep outer shelf to shallow inner shelf. */
  slices?: Polygon[][];
}

export interface VisualizationInput {
  inventory?: DependencyInventory;
  modules: { id: string; package: string; x: number; y: number }[];
  packages: { id: string; layer: number | null; size: number }[];
  routes: { from: string; to: string; weight: number }[];
}

export const maximumFoundationInfluence = 4;

export const defaultVisualizationSettings = {
  foundationInfluence: 1,
  islandClearance: 45,
};
export type VisualizationSettings = typeof defaultVisualizationSettings;

/** Renderer-independent vector geometry, built after analysis and before publication. */
export interface PreparedVisualization {
  foundations: DependencyFoundation[];
  groups: FoundationGroup[];
  height: number;
  inputKey: string;
  islands: IslandGeometry[];
  policyVersion: 5;
  schemaVersion: 1;
  settings: VisualizationSettings;
  width: number;
}
