import {
  type ArchipelagoPlatform,
  archipelagoPlatform,
} from "../../lib/visualization/archipelago-platform";
import type { Landform } from "../../lib/visualization/geology";
import {
  type IslandLandform,
  landformFor,
} from "../../lib/visualization/landforms";
import type { Seafloor } from "../../lib/visualization/seafloor-features";
import type { StructuralTerrain } from "../../lib/visualization/terrain";
import {
  type WorldTerrain,
  worldTerrain,
} from "../../lib/visualization/world-terrain";
import type { SpyglassData } from "../data/types";
import { chartSeafloor } from "./chart-seafloor";
import { chartTerrain } from "./chart-terrain";
import { islandLandforms } from "./landform-metrics";

/**
 * The chart's world terrain, from its settled layout: the structural
 * terrain, each workspace frame's archipelago platform, the seabed features
 * built over the platformed seabed, and every island's landform, composed
 * into one continuous field. The structural terrain, the platforms and the
 * world terrain are cached by content, so a second build over the same
 * layout reuses all three.
 */
export interface ChartWorld {
  /** Every island's land surface, as `landformFor` builds it. */
  landform: Landform;
  /** Every island's formation and geometry, by island id. */
  landforms: ReadonlyMap<string, IslandLandform>;
  /** Each frame's platform and the seabed raised to them. */
  platform: ArchipelagoPlatform;
  /** The seabed's features, built over the platformed seabed. */
  seafloor: Seafloor;
  terrain: StructuralTerrain;
  world: WorldTerrain;
}

/**
 * Content identity of the landforms, for the world terrain's cache: each
 * island's formation and the geometry it is built over, by island id.
 */
function landformKey(landforms: ReadonlyMap<string, IslandLandform>): string {
  return JSON.stringify(
    [...landforms]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, { archetype, params }]) => [id, archetype, params])
  );
}

export function chartWorld(
  data: Pick<
    SpyglassData,
    | "formerPackages"
    | "foundationGroups"
    | "foundations"
    | "frames"
    | "height"
    | "internalFoundations"
    | "routes"
    | "territories"
    | "width"
  >
): ChartWorld {
  const terrain = chartTerrain(data);
  // Each frame is one workspace, grouped as `chartSeafloor` groups them.
  const frameOf = new Map(
    data.frames.flatMap((frame) =>
      frame.territories.map((id) => [id, frame.id] as const)
    )
  );
  const platform = archipelagoPlatform({
    islands: data.territories.map((territory) => ({
      coast: territory.coast,
      group: frameOf.get(territory.id) ?? "",
      id: territory.id,
      radius: territory.radius,
      x: territory.x,
      y: territory.y,
    })),
    terrain,
  });
  // Features read the platformed seabed, so a channel carves the platform.
  const seafloor = chartSeafloor(data, {
    ...terrain,
    surface: { ...terrain.surface, elevation: platform.seabed },
  });
  const landforms = islandLandforms(data);
  const landform = landformFor(landforms);
  const world = worldTerrain({
    contributions: seafloor.contributions,
    islands: data.territories,
    landform,
    landformKey: landformKey(landforms),
    platform,
    terrain,
  });
  return { landform, landforms, platform, seafloor, terrain, world };
}
