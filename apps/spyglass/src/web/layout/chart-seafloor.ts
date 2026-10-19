import {
  defaultSeafloorSettings,
  type Seafloor,
  type SeafloorSettings,
  seafloorFeatures,
} from "../../lib/visualization/seafloor-features";
import type { StructuralTerrain } from "../../lib/visualization/terrain";
import type { SpyglassData } from "../data/types";

/**
 * The chart's seabed features, from its settled islands, their routes, and
 * its former packages, over the structural terrain built from the same
 * layout. Each workspace frame is its own archipelago. A former package is a
 * drowned island: a seamount stands where its wreck is drawn.
 */
export function chartSeafloor(
  data: Pick<
    SpyglassData,
    "formerPackages" | "frames" | "routes" | "territories"
  >,
  terrain: StructuralTerrain,
  settings: SeafloorSettings = defaultSeafloorSettings
): Seafloor {
  const frameOf = new Map(
    data.frames.flatMap((frame) =>
      frame.territories.map((id) => [id, frame.id] as const)
    )
  );
  return seafloorFeatures(
    {
      islands: data.territories.map((territory) => ({
        coast: territory.coast,
        group: frameOf.get(territory.id) ?? "",
        id: territory.id,
        label: territory.label,
        radius: territory.radius,
        x: territory.x,
        y: territory.y,
      })),
      links: data.routes.map(({ from, to, weight }) => ({ from, to, weight })),
      summits: (data.formerPackages ?? []).map((former) => ({
        id: former.id,
        label: former.label,
        members: [former.id],
        x: former.x,
        y: former.y,
      })),
      terrain,
    },
    settings
  );
}
