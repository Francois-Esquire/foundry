/** Bake tiles are stitched into ordinary 2D maps. The frame never addresses tiles. */
import type { Chart } from "../../../data/chart";
import { COASTS_RESOLUTION, MAX_BANK_ISLANDS } from "./map-data";
import type { MapParams } from "./map-params";
import { MAP_MARGIN, type MapFrame, mapFrame } from "./map-uniforms";

/** The banks the rings map holds a bit each for: 16 in each of g, b, a (height.wgsl `RING_BITS`). */
const RING_BITS = 48;
/** Banks per footprint layer: the 128 bits of an rgba32uint texel. */
const BANKS_PER_PAGE = 128;
/** The most bank ids a 16-bit rings channel can hold, past 0 for none. */
const MAX_BANKS = 65_534;

/** How a chart's size shapes its bake, from its island and group counts. */
export interface ChartCapacity {
  /** Bank footprint layers, at least one, when `footprints`. */
  readonly footprintPages: number;
  /** Banks past the rings map's bits, or islands past private state: footprints are baked. */
  readonly footprints: boolean;
  /** Islands past `MAX_BANK_ISLANDS`: the height kernel keeps their state in workspace. */
  readonly scalable: boolean;
}

export function capacityOf(chart: Chart): ChartCapacity {
  const scalable = chart.islands.length > MAX_BANK_ISLANDS;
  return {
    footprintPages: Math.max(
      1,
      Math.ceil(chart.groups.length / BANKS_PER_PAGE)
    ),
    footprints: scalable || chart.groups.length > RING_BITS,
    scalable,
  };
}

export interface BakeLayout extends ChartCapacity {
  readonly coastColumns: number;
  readonly coastLayers: number;
  readonly coastResolution: number;
  readonly frame: MapFrame;
  readonly tiles: number;
}

export function bakeLayout(
  chart: Chart,
  params: MapParams,
  maxTextureSize: number,
  maxLayers: number
): BakeLayout {
  const capacity = capacityOf(chart);
  const extent =
    Math.max(chart.extent.width, chart.extent.height) * (1 + 2 * MAP_MARGIN);
  // A power of two a side, so every map's side is one too, as its mip
  // chain needs (downsample.wgsl halves whole 2×2 blocks).
  const tiles =
    params.tileWorldSize > 0
      ? 2 ** Math.ceil(Math.log2(Math.max(1, extent / params.tileWorldSize)))
      : 1;
  const resolution = params.resolution * tiles;
  const side = params.tileWorldSize > 0 ? params.tileWorldSize * tiles : extent;
  const frame =
    tiles === 1 && params.tileWorldSize === 0
      ? mapFrame(chart, resolution)
      : {
          origin: [-side / 2, -side / 2] as const,
          resolution,
          texel: side / resolution,
        };
  const coastResolution = COASTS_RESOLUTION * tiles;
  const coastColumns = capacity.scalable
    ? Math.min(4, Math.floor(maxTextureSize / coastResolution))
    : 1;
  const coastLayers = Math.max(
    1,
    Math.ceil(chart.islands.length / coastColumns ** 2)
  );
  if (
    resolution > maxTextureSize ||
    coastColumns < 1 ||
    coastLayers > maxLayers ||
    capacity.footprintPages > maxLayers ||
    chart.groups.length > MAX_BANKS
  ) {
    throw new Error(
      `Islands bake exceeds this GPU's resident map capacity (${maxTextureSize}px, ${maxLayers} layers). No islands were dropped.`
    );
  }
  return {
    ...capacity,
    coastColumns,
    coastLayers,
    coastResolution,
    frame,
    tiles,
  };
}
