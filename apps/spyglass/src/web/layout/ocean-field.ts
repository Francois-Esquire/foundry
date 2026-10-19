import { shoreDistances } from "../../lib/visualization/distance-field";
import { fillPolygon } from "../../lib/visualization/scanline-fill";
import type { Polygon, SpyglassData } from "../data/types";
import { archipelagoRims, flattenArchipelago } from "./archipelago";

type Point = [number, number];

/**
 * Four sample points in each cell, on the rotated grid. A cell is land where
 * any of them falls within a coast. This is the mask the GPU-accelerated
 * canvas fill this field replaces produced, counting every pixel one of its
 * four multisamples covered as land, so the phase 0 captures hold as the
 * comparison; the rule is pure, and phase 4 may choose its own when the
 * field becomes a texture.
 */
const cellSamples: readonly (readonly [number, number])[] = [
  [0.375, 0.125],
  [0.875, 0.375],
  [0.125, 0.625],
  [0.625, 0.875],
];

/** The sea's distance fields on one grid over the chart, in cells. */
export interface OceanField {
  /** Distance from each cell to the nearest coast, in cells; 0 on land. */
  distances: Float32Array;
  height: number;
  /** 1 where a coast polygon reaches the cell. */
  land: Uint8Array;
  /** Distance from each cell to the nearest archipelago rim, in cells; 0 inside one. */
  outside: Float32Array;
  /** The rims the open-sea field was built from, in map units. */
  rims: Point[][];
  /** Cells per map unit; divide a field value by it for map units. */
  scale: number;
  width: number;
}

/**
 * The rim's distance alone, on a grid over an extent of `width` by `height`
 * map units about the chart's centre, for the surf: the sea's shade field
 * steps open water over tens of units and its cells may be several units
 * wide, where a band a few units beyond the rim wants cells about a unit
 * wide, so the surf measures the rims again on a finer grid, over an extent
 * just large enough to hold them.
 */
export interface RimField {
  /** The extent the grid covers, in map units about the chart's centre. */
  extent: { height: number; width: number };
  height: number;
  /** Distance from each cell to the nearest rim, in cells; 0 inside one. */
  outside: Float32Array;
  /** Cells per map unit; divide a field value by it for map units. */
  scale: number;
  width: number;
}

/** The rims' distance field over `extent` map units, on `resolution` cells across the longer side. */
export function rimField(
  rims: Point[][],
  extent: { height: number; width: number },
  resolution: number
): RimField {
  const scale = resolution / Math.max(extent.width, extent.height);
  const width = Math.max(1, Math.round(extent.width * scale));
  const height = Math.max(1, Math.round(extent.height * scale));
  const toGrid = (x: number, y: number): Point => [
    ((x + extent.width / 2) * width) / extent.width,
    ((y + extent.height / 2) * height) / extent.height,
  ];
  const region = new Uint8Array(width * height);
  const cell = Math.max(extent.width / width, extent.height / height);
  for (const rim of rims) {
    fillPolygon(
      region,
      width,
      height,
      [flattenArchipelago(rim, cell / 2).map(([x, y]) => toGrid(x, y))],
      cellSamples
    );
  }
  return {
    extent,
    height,
    outside: shoreDistances(region, width, height),
    scale,
    width,
  };
}

/**
 * Coast and rim masks and their distance fields, rasterized by scanline on a
 * grid of `resolution` cells across the chart's longer side. No canvas: the
 * painters shade and stroke what this returns.
 */
export function oceanField(
  data: SpyglassData,
  resolution = 640,
  coasts?: Polygon[]
): OceanField {
  const scale = resolution / Math.max(data.width, data.height);
  const width = Math.max(1, Math.round(data.width * scale));
  const height = Math.max(1, Math.round(data.height * scale));
  const toGrid = (x: number, y: number): Point => [
    ((x + data.width / 2) * width) / data.width,
    ((y + data.height / 2) * height) / data.height,
  ];
  const lands = coasts ? [{ coast: coasts, x: 0, y: 0 }] : data.territories;
  const land = new Uint8Array(width * height);
  for (const p of lands) {
    for (const polygon of p.coast) {
      fillPolygon(
        land,
        width,
        height,
        polygon.map((ring) => ring.map(([x, y]) => toGrid(p.x + x, p.y + y))),
        cellSamples
      );
    }
  }
  const distances = shoreDistances(land, width, height);
  // One rim per frame; a single workspace's is the whole archipelago's.
  const rims = archipelagoRims(data);
  const region = Uint8Array.from(land);
  const cell = Math.max(data.width / width, data.height / height);
  for (const rim of rims) {
    fillPolygon(
      region,
      width,
      height,
      [flattenArchipelago(rim, cell / 2).map(([x, y]) => toGrid(x, y))],
      cellSamples
    );
  }
  const outside = shoreDistances(region, width, height);
  return { distances, height, land, outside, rims, scale, width };
}
