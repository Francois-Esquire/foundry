import {
  type ArchipelagoOutline,
  archipelagoOutline,
  defaultHullSettings,
  type EmanationField,
  emanationField,
  type HullRing,
  type HullSettings,
  hullRings,
} from "../../lib/visualization/archipelago-hull";
import type { SpyglassData } from "../data/types";

/** The chart's outer hulls and the emanation from them over the sea. */
export interface ChartHull {
  field: EmanationField;
  /** Content identity, for caches. */
  key: string;
  /** One outline per workspace frame, sorted by frame id. */
  outlines: readonly ArchipelagoOutline[];
  /**
   * The field's rings as polylines in map units, by index outward, as
   * `hullRings` traces them: traced the first time they are asked for and
   * the same array on every ask after, so a frame may read them freely.
   */
  rings: () => readonly HullRing[];
}

/** FNV-1a over a string: content identity for the cache, never a security hash. */
function hashText(text: string): number {
  let h = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    // biome-ignore lint/suspicious/noBitwiseOperators: A deterministic 32-bit hash identifies a cached hull.
    h = Math.imul(h ^ text.charCodeAt(index), 16_777_619) >>> 0;
  }
  return h;
}

/** Most recent hulls kept by content. */
const cacheEntries = 4;
const cache = new Map<string, ChartHull>();

/**
 * The chart's outer hulls, one per workspace frame grouped as
 * `chartSeafloor` groups them, and their emanation over the sea's `extent`,
 * map units about the chart's centre: the extent the sea's plane and the
 * geology preview fill, from `chartSeaBounds`. Built once per content and
 * reused while the islands, the extent and the settings are unchanged.
 */
export function chartHull(
  data: Pick<SpyglassData, "frames" | "territories">,
  extent: { height: number; width: number },
  settings: HullSettings = defaultHullSettings
): ChartHull {
  const frameOf = new Map(
    data.frames.flatMap((frame) =>
      frame.territories.map((id) => [id, frame.id] as const)
    )
  );
  const islands = data.territories
    .map((territory) => ({
      coast: territory.coast,
      group: frameOf.get(territory.id) ?? "",
      id: territory.id,
      radius: territory.radius,
      x: territory.x,
      y: territory.y,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const key = `hull:${hashText(
    JSON.stringify([
      settings,
      extent.width,
      extent.height,
      islands.map(({ coast, group, id, radius, x, y }) => [
        id,
        group,
        x,
        y,
        radius,
        coast,
      ]),
    ])
  ).toString(16)}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const outlines = archipelagoOutline({ islands }, settings);
  const field = emanationField(outlines, extent, settings);
  let rings: readonly HullRing[] | undefined;
  const hull: ChartHull = {
    field,
    key,
    outlines,
    rings: () => {
      rings ??= hullRings(field, settings.rings);
      return rings;
    },
  };
  cache.set(key, hull);
  while (cache.size > cacheEntries) {
    const [oldest] = cache.keys();
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
  return hull;
}
