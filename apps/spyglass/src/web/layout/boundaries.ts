import {
  contributionBoundary,
  depthContours,
  type StructuralTerrain,
  terrainSilhouette,
} from "../../lib/visualization/terrain";
import type { SpyglassData } from "../data/types";
import type { BoundaryId } from "../settings/boundary-settings";
import { chartTerrain } from "./chart-terrain";
import { landmassFootprint } from "./landmass-footprint";
import { landmassHull } from "./landmass-hull";
import { packageGroups } from "./landmasses";

/** The layout's outlines a developer can turn on, one set of rings per boundary. */
export type BoundaryLayers = Record<BoundaryId, [number, number][][]>;

/** Elevations the developer's depth contours follow, from the abyss up. */
const depthContourLevels = [-0.9, -0.8, -0.7, -0.6, -0.5, -0.4, -0.3, -0.2];

/** Every ring of some polygons, outer rings and holes alike, as outlines. */
function rings(
  polygons: readonly [number, number][][][]
): [number, number][][] {
  return polygons.flat();
}

export function spyglassBoundaries(
  data: SpyglassData,
  coastalBuffer = 32,
  suppliedFootprints?: ReturnType<typeof landmassFootprint>[],
  terrain: StructuralTerrain = chartTerrain(data)
): BoundaryLayers {
  const groups = packageGroups(
    data.territories,
    data.routes,
    data.declaredDependencies
  ).filter((g) => g.length > 1);
  const footprints =
    suppliedFootprints ??
    groups.map((group) => landmassFootprint(group, coastalBuffer));
  return {
    clearance: data.territories.map((p) => landmassHull([p])),
    coasts: data.territories.flatMap((p) =>
      p.coast.flatMap((polygon) =>
        polygon.map((ring) =>
          ring.map(([x, y]): [number, number] => [x + p.x, y + p.y])
        )
      )
    ),
    depths: depthContours(terrain, depthContourLevels).flatMap(rings),
    footprint: footprints.flatMap((f) => f.outline),
    foundations: terrain.contributions.flatMap((contribution) =>
      rings(contributionBoundary(terrain, contribution))
    ),
    groups: groups.map((g) => landmassHull(g)),
    outer: rings(terrainSilhouette(terrain)),
    pockets: footprints.flatMap((f) => f.pocketRings),
  };
}
