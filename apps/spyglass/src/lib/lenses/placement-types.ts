import type { PackageShapeSignal, SurfaceDependencies } from "../types";

export const PLACEMENT_SCHEMA_VERSION = 1;

export const PLACEMENT_POLICY = { dominantShare: 0.6 } as const;

export type PlacementLabel = "fits" | "spread" | "departs";

export type PlacementLevel = "symbol" | "file" | "folder" | "package";

interface PlacementAway {
  modules: string[];
  package: string;
}

interface PlacementEvidence {
  away: PlacementAway[];
  home: { modules: string[] };
  level: PlacementLevel;
  package: string;
  place: string;
  unindexed: number;
}

export type Placement = PlacementEvidence &
  (
    | { label: "fits" | "spread" }
    | {
        label: "departs";
        toward: string;
      }
  );

export type PlacementCounts = Record<PlacementLabel | "unconsumed", number>;

export interface PlacementPackage {
  counts: Record<PlacementLevel, PlacementCounts>;
  id: string;
  path: string;
  primaryConsumer?: NonNullable<SurfaceDependencies["primaryConsumer"]>;
  shapeSignals: PackageShapeSignal[];
  unindexed: number;
}

export interface Placements {
  missing: string[];
  packages: PlacementPackage[];
  places: Placement[];
  policy: { dominantShare: number };
}
