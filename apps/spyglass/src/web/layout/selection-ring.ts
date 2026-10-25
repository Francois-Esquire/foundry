import { contours } from "d3-contour";
import { shoreDistances } from "../../lib/visualization/distance-field";
import { fillPolygon } from "../../lib/visualization/scanline-fill";
import type { Territory } from "../data/types";

type Point = [number, number];

/** Offshore distance of the selection ring, in map units. */
export const selectionOffset = 5;
const ringCell = 1;

const rings = new WeakMap<Territory, Point[][]>();

/** Even-odd scanline fill of the coast on a local grid, sampled at cell centres. */
function landMask(
  territory: Territory,
  left: number,
  top: number,
  width: number,
  height: number
) {
  const land = new Uint8Array(width * height);
  for (const polygon of territory.coast) {
    fillPolygon(
      land,
      width,
      height,
      polygon.map((ring) =>
        ring.map(
          ([x, y]): Point => [(x - left) / ringCell, (y - top) / ringCell]
        )
      )
    );
  }
  return land;
}

/**
 * The selected island's surround: the contour `selectionOffset` units offshore
 * of its own coast, in world coordinates. Built once per island.
 */
export function selectionRing(territory: Territory): Point[][] {
  const cached = rings.get(territory);
  if (cached) {
    return cached;
  }
  const points = territory.coast.flat(2);
  if (!points.length) {
    rings.set(territory, []);
    return [];
  }
  const margin = selectionOffset + 4;
  const left = Math.min(...points.map(([x]) => x)) - margin;
  const top = Math.min(...points.map(([, y]) => y)) - margin;
  const width = Math.ceil(
    (Math.max(...points.map(([x]) => x)) + margin - left) / ringCell
  );
  const height = Math.ceil(
    (Math.max(...points.map(([, y]) => y)) + margin - top) / ringCell
  );
  const distances = shoreDistances(
    landMask(territory, left, top, width, height),
    width,
    height
  );
  const [band] = contours()
    .size([width, height])
    .thresholds([selectionOffset / ringCell])(Array.from(distances));
  const result = (band?.coordinates.flat() ?? [])
    .filter((ring) =>
      ring.every(
        ([x = 0, y = 0]) =>
          x > 0.5 && y > 0.5 && x < width - 0.5 && y < height - 0.5
      )
    )
    .map((ring) =>
      ring.map(
        ([x = 0, y = 0]): Point => [
          territory.x + left + x * ringCell,
          territory.y + top + y * ringCell,
        ]
      )
    );
  rings.set(territory, result);
  return result;
}
