import { byCodeUnit } from "@foundry/lib/ordering";
import { contours } from "d3-contour";

import { latitude } from "./codex/bindings";
import type { AtlasData, AtlasFile, Polygon, Territory } from "./types";

export function unit(id: string): number {
  let h = 2_166_136_261;
  for (const c of id) {
    // biome-ignore lint/suspicious/noBitwiseOperators: Preserve the deterministic 32-bit hash used for map placement and colors.
    h = Math.imul(h ^ c.charCodeAt(0), 16_777_619);
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Preserve the deterministic 32-bit hash used for map placement and colors.
  return (h >>> 0) / 4_294_967_296;
}

/** The padding an island keeps around its coast when islands are spaced, as `landmassHull` pads it. */
const shorePadding = 32;
/** Open sea kept beyond the outermost islands when the chart's extent is measured. */
const chartMargin = 120;
/**
 * Further sea below the southernmost row, so that at overview the foundation
 * row and its tick on the latitude scale sit above the legend in the lower
 * right rather than under it.
 */
const footSea = 160;

/** How far an island's padded coast reaches from its centre; its footprint radius before it has a coast. */
function reach(territory: Territory): number {
  const points = territory.coast.flatMap((polygon) => polygon[0] ?? []);
  const farthest = points.length
    ? Math.max(...points.map(([x = 0, y = 0]) => Math.hypot(x, y)))
    : territory.radius;
  return farthest + shorePadding;
}

const folderOrder = byCodeUnit((p: Territory) => p.folder);
const idOrder = byCodeUnit((p: Territory) => p.id);
/** A row's west-to-east order: by package folder, compared by code unit, then by id. */
const byFolder = (a: Territory, b: Territory) =>
  folderOrder(a, b) || idOrder(a, b);

/**
 * Places each island on its dependency layer's row, with nothing pulling
 * islands together: position means the folder tree, and relationships are
 * drawn as marks. Rows sit at `latitude(layer)`, all moved by one offset so
 * the atlas is centred on the chart. A row runs west to east in package
 * folder order, so packages in one folder sit side by side, packed with
 * `clearance` between padded coasts and centred. Islands of different rows
 * that would still overlap are moved apart along x only, so no island leaves
 * its row. An unplaced package sits on the foundation's.
 */
export function settlePackages(
  territories: Territory[],
  layers: Readonly<Record<string, number | null>>,
  clearance: number
): void {
  // Measured once: the passes below read each for every pair.
  const reaches = new Map(territories.map((p) => [p, reach(p)]));
  const reachOf = (p: Territory) => reaches.get(p) ?? p.radius;
  const rows = new Map<number, Territory[]>();
  for (const territory of territories) {
    const layer = layers[territory.id] ?? 0;
    territory.y = latitude(layer);
    rows.set(layer, [...(rows.get(layer) ?? []), territory]);
  }
  const order: Territory[] = [];
  for (const [, row] of [...rows].sort(([a], [b]) => a - b)) {
    row.sort(byFolder);
    let east = 0;
    for (const territory of row) {
      territory.x = east + reachOf(territory);
      east = territory.x + reachOf(territory) + clearance;
    }
    const width = east - clearance;
    for (const territory of row) {
      territory.x -= width / 2;
    }
    order.push(...row);
  }
  separateAlongX(order, reachOf, clearance);
  centre(order, reachOf);
}

/**
 * Moves every island by one offset, so the islands' padded extent, with
 * `footSea` below it, is centred on the origin, as the chart is.
 */
function centre(
  territories: Territory[],
  reachOf: (territory: Territory) => number
) {
  const west = Math.min(...territories.map((p) => p.x - reachOf(p)));
  const east = Math.max(...territories.map((p) => p.x + reachOf(p)));
  const north = Math.min(...territories.map((p) => p.y - reachOf(p)));
  const south = Math.max(...territories.map((p) => p.y + reachOf(p))) + footSea;
  for (const territory of territories) {
    territory.x -= (west + east) / 2;
    territory.y -= (north + south) / 2;
  }
}

/** Overlapping islands, first in `order` to the west on a tie, are pushed apart along x until none overlap. */
function separateAlongX(
  order: Territory[],
  reachOf: (territory: Territory) => number,
  clearance: number
) {
  for (let pass = 0; pass < 400; pass += 1) {
    let largest = 0;
    for (const [i, a] of order.entries()) {
      for (const b of order.slice(i + 1)) {
        const span = reachOf(a) + reachOf(b) + clearance;
        const dy = b.y - a.y;
        if (Math.abs(dy) >= span) {
          continue;
        }
        const needed = Math.sqrt(span ** 2 - dy ** 2);
        const dx = b.x - a.x;
        const overlap = needed - Math.abs(dx);
        if (overlap <= 0) {
          continue;
        }
        largest = Math.max(largest, overlap);
        const east = dx === 0 ? 1 : Math.sign(dx);
        a.x -= (east * overlap) / 2;
        b.x += (east * overlap) / 2;
      }
    }
    if (largest < 0.01) {
      return;
    }
  }
}

/** The chart's extent: symmetric about the origin, with open sea beyond the outermost islands. */
export function chartSize(territories: readonly Territory[]) {
  return {
    height:
      2 *
      (Math.max(0, ...territories.map((p) => Math.abs(p.y) + p.radius)) +
        chartMargin),
    width:
      2 *
      (Math.max(0, ...territories.map((p) => Math.abs(p.x) + p.radius)) +
        chartMargin),
  };
}

/** The atlas with its islands placed again at another clearance; coasts and file positions are unchanged. */
export function relayoutAtlas(data: AtlasData, clearance: number): AtlasData {
  const territories = data.territories.map((p) => ({ ...p }));
  settlePackages(territories, data.packageLayers, clearance);
  return { ...data, ...chartSize(territories), territories };
}

/**
 * The spread of each file's influence on its island's land: wider for a
 * sparse island, between 4 and 10 units.
 */
export function contourSigma(radius: number, files: number) {
  return Math.max(4, Math.min(10, (radius / Math.sqrt(files)) * 0.65));
}

export function landContours(files: AtlasFile[], radius: number): Polygon[][] {
  if (!files.length) {
    return [[], [], []];
  }
  const size = 112;
  const span = radius * 2.5;
  const cell = span / size;
  const sigma = contourSigma(radius, files.length);
  const field = new Array<number>(size * size).fill(0);
  for (const f of files) {
    const cx = (f.x + span / 2) / cell;
    const cy = (f.y + span / 2) / cell;
    const extent = Math.ceil((sigma * 3) / cell);
    for (
      let y = Math.max(0, Math.floor(cy - extent));
      y < Math.min(size, cy + extent);
      y += 1
    ) {
      for (
        let x = Math.max(0, Math.floor(cx - extent));
        x < Math.min(size, cx + extent);
        x += 1
      ) {
        const d2 = ((x - cx) ** 2 + (y - cy) ** 2) * cell ** 2;
        field[y * size + x] =
          (field[y * size + x] ?? 0) + Math.exp(-d2 / (2 * sigma ** 2));
      }
    }
  }
  return contours()
    .size([size, size])
    .thresholds([0.18, 0.5, 1.8])(field)
    .map((c) =>
      c.coordinates.map((polygon) =>
        polygon.map((ring) =>
          ring.map(([x = 0, y = 0]): [number, number] => [
            x * cell - span / 2,
            y * cell - span / 2,
          ])
        )
      )
    );
}

export function territoryLabelY(territory: Territory): number {
  return (
    Math.min(
      0,
      ...territory.coast.flatMap((p) => p[0]?.map((point) => point[1]) ?? [])
    ) - 17
  );
}
