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

/**
 * One shared membership set, with all its dependency identities retained.
 * Its boundary is taken from the structural terrain, not baked here.
 */
export interface FoundationGroup {
  dependencyIds: string[];
  id: string;
  memberIds: string[];
}

/** One package's shortest runtime path to a workspace package it relies on. */
export interface InternalFoundationMember {
  direct: boolean;
  distance: number;
  territoryId: string;
  /** Distance attenuation, as a third-party member's, without usage refinement. */
  weight: number;
}

/**
 * A workspace package other workspace packages rely on. It is a different
 * relationship from shared third-party code and keeps its own identity:
 * `workspace:` and the supplier's id.
 */
export interface InternalFoundation {
  id: string;
  /** The dependents only; the supplier is never its own member. */
  members: InternalFoundationMember[];
  /** Distinct dependents. */
  prominence: number;
  supplierId: string;
}

export interface VisualizationInput {
  inventory?: DependencyInventory;
  modules: { id: string; package: string; x: number; y: number }[];
  packages: { id: string; layer: number | null; size: number }[];
  routes: { from: string; to: string; weight: number }[];
}

export const maximumFoundationInfluence = 4;

/** Bumped when prepared geometry changes meaning; older artifacts are prepared again. */
export const visualizationPolicyVersion = 6;

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
  internalFoundations: InternalFoundation[];
  islands: IslandGeometry[];
  policyVersion: typeof visualizationPolicyVersion;
  schemaVersion: 1;
  settings: VisualizationSettings;
  width: number;
}
