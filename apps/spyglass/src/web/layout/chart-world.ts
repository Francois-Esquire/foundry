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
 * terrain, its seabed features, and every island's landform, composed into
 * one continuous field. The structural terrain and the world terrain are
 * cached by content, so a second build over the same layout reuses both.
 */
export interface ChartWorld {
  /** Every island's land surface, as `landformFor` builds it. */
  landform: Landform;
  /** Every island's formation and geometry, by island id. */
  landforms: ReadonlyMap<string, IslandLandform>;
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
  const seafloor = chartSeafloor(data, terrain);
  const landforms = islandLandforms(data);
  const landform = landformFor(landforms);
  const world = worldTerrain({
    contributions: seafloor.contributions,
    islands: data.territories,
    landform,
    landformKey: landformKey(landforms),
    terrain,
  });
  return { landform, landforms, seafloor, terrain, world };
}
