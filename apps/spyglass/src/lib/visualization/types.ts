import type { DependencyInventory } from "../dependency-inventory-types";

export type Polygon = [number, number][][];

export interface FoundationMember {
  direct: boolean;
  distance: number;
  territoryId: string;
  usage?: {
    importingFiles: string[];
    runtimeFiles: string[];
    typeOnlyFiles: string[];
  };
  weight: number;
}

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
  prominence: number;
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

export interface FoundationGroup {
  dependencyIds: string[];
  id: string;
  memberIds: string[];
}

interface InternalFoundationMember {
  direct: boolean;
  distance: number;
  territoryId: string;
  weight: number;
}

export interface InternalFoundation {
  id: string;
  members: InternalFoundationMember[];
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

export const visualizationPolicyVersion = 6;

export const defaultVisualizationSettings = {
  foundationInfluence: 1,
  islandClearance: 45,
};
export type VisualizationSettings = typeof defaultVisualizationSettings;

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
