import type { SpyglassData } from "../data/types";
import type { BoundaryId } from "../settings/boundary-settings";
import { archipelagoRims } from "./archipelago";
import { landmassFootprint } from "./landmass-footprint";
import { landmassHull } from "./landmass-hull";
import { packageGroups } from "./landmasses";

/** The layout's outlines a developer can turn on, one set of rings per boundary. */
export type BoundaryLayers = Record<BoundaryId, [number, number][][]>;

export function spyglassBoundaries(
  data: SpyglassData,
  coastalBuffer = 32,
  suppliedFootprints?: ReturnType<typeof landmassFootprint>[]
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
    footprint: footprints.flatMap((f) => f.outline),
    groups: groups.map((g) => landmassHull(g)),
    outer: archipelagoRims(data),
    pockets: footprints.flatMap((f) => f.pocketRings),
  };
}
