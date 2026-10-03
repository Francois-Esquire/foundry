import type { Landmark } from "../landmarks";
import type { Territory } from "../types";
import { sampleReliefInk } from "./relief-ink";
import { createTerrainField } from "./terrain-field";
import { sampleTerrainSurface } from "./terrain-surface";
import { landContours } from "./topography";

export interface ReliefRequest {
  landmarks: readonly Landmark[];
  positions: Float32Array[];
  territory: Territory;
  thickness: number;
}

export function prepareRelief(request: ReliefRequest) {
  const { landmarks, positions, territory, thickness } = request;
  const field = createTerrainField(territory, landmarks);
  return {
    contours: landContours(territory, field),
    strokes: sampleReliefInk(territory, field).strokes,
    surfaces: positions.map((vertices) =>
      sampleTerrainSurface(vertices.slice(), territory, field, thickness)
    ),
  };
}

export type PreparedRelief = ReturnType<typeof prepareRelief>;
