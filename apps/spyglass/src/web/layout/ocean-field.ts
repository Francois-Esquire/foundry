import type { Polygon, SpyglassData } from "../data/types";
import { archipelagoRims, flattenArchipelago } from "./archipelago";
import { shoreDistances } from "./distance-field";
import { fillPolygon } from "./scanline-fill";

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
