import {
  type ArchipelagoPlatform,
  archipelagoPlatform,
} from "../../lib/visualization/archipelago-platform";
import {
  bankContributions,
  type CoastSettings,
  defaultCoastSettings,
  previewShores,
} from "../../lib/visualization/coasts";
import { geologyLevels, type Landform } from "../../lib/visualization/geology";
import {
  defaultLagoonSettings,
  type LagoonSettings,
  type LagoonSite,
} from "../../lib/visualization/lagoons";
import {
  defaultLandformSettings,
  type IslandLandform,
  landformFor,
} from "../../lib/visualization/landforms";
import type { Seafloor } from "../../lib/visualization/seafloor-features";
import type {
  StructuralTerrain,
  TerrainIsland,
} from "../../lib/visualization/terrain";
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
 * into one continuous field over the preview's coasts: the surveyed coasts
 * cleaned and sculpted, a sand bank raised under the water between each
 * cay and the land it lies off, and each atoll's lagoon and inlets carved
 * in. The
 * structural terrain, the platforms and the world terrain are cached by
 * content, so a second build over the same layout reuses all three. The
 * default map keeps the surveyed coasts; only the geology preview reads
 * this.
 */
export interface ChartWorld {
  /** The islands with the preview's coasts, which the world's land is built on. */
  islands: readonly TerrainIsland[];
  /**
   * Every island's land surface at any map position: `landformFor`'s,
   * told each position's piece depth, with the atolls' lagoons carved in.
   * Below the water only inside a lagoon or an inlet.
   */
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

/** How the preview cleans and sculpts its coasts and carves its lagoons. */
export interface ChartWorldSettings {
  coasts: CoastSettings;
  /** Share of an atoll's rim fall, past the rim, where its lagoon's water begins. */
  lagoonShore: number;
  lagoons: LagoonSettings;
}

const defaultChartWorldSettings: ChartWorldSettings = {
  coasts: defaultCoastSettings,
  lagoonShore: 0.7,
  lagoons: defaultLagoonSettings,
};

/**
 * Where each atoll's lagoon lies: past the rim its landform raises at
 * `formation.reach` of its depth, `lagoonShore` of the way down the rim's
 * fall, with the landform's beach bench for its inner beach.
 */
function lagoonSites(
  landforms: ReadonlyMap<string, IslandLandform>,
  lagoonShore: number
): LagoonSite[] {
  const { atoll, beach } = defaultLandformSettings;
  return [...landforms]
    .filter(([, { archetype }]) => archetype === "atoll")
    .map(([islandId, { params }]) => ({
      beachHeight: beach.height * geologyLevels.land,
      islandId,
      shore: params.depth * (atoll.formation.reach + atoll.fall * lagoonShore),
    }));
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
  >,
  settings: ChartWorldSettings = defaultChartWorldSettings
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
  // The world terrain builds the same coasts again, from the cache.
  const shores = previewShores(data.territories, settings.coasts);
  const world = worldTerrain({
    coasts: settings.coasts,
    contributions: [
      ...seafloor.contributions,
      ...bankContributions(
        shores.banks,
        terrain,
        platform.seabed,
        settings.coasts.islets.bank
      ),
    ],
    islands: data.territories,
    lagoons: {
      settings: settings.lagoons,
      sites: lagoonSites(landforms, settings.lagoonShore),
    },
    landform: landformFor(landforms),
    landformKey: landformKey(landforms),
    platform,
    terrain,
  });
  return {
    islands: world.islands,
    landform: world.landform,
    landforms,
    platform,
    seafloor,
    terrain,
    world,
  };
}
