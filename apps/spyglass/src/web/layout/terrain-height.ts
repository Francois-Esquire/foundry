import { islandPlinth, paperThickness } from "../data/bindings";
import type { Territory } from "../data/types";
import { baseTerrainField } from "./terrain-field";

/** The island's top surface: plinth plus usage relief above the paper. */
export const islandTop = paperThickness + islandPlinth;

export function terrainHeight(p: Territory, x: number, y: number): number {
  return islandTop + baseTerrainField(p).sample(x, y).elevation;
}

/** Where a flat mark lies: just above the paper. */
export const flatMarkHeight = paperThickness + 0.02;

/** A draped mark sits this far above the relief, as the flat ones do above the paper. */
const drapeLift = 0.02;

/**
 * The height a draped mark takes over a chart point on an island: the relief
 * there, plus the lift. A label set on the mark it names takes the same, so
 * it sits on the mark.
 */
export function drapedHeight(
  territory: Territory,
  x: number,
  y: number
): number {
  return terrainHeight(territory, x - territory.x, y - territory.y) + drapeLift;
}
