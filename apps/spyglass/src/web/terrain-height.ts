import { islandPlinth, paperThickness } from "./data/bindings";
import type { Territory } from "./data/types";
import { baseTerrainField } from "./terrain-field";

/** The island's top surface: plinth plus usage relief above the paper. */
export const islandTop = paperThickness + islandPlinth;

export function terrainHeight(p: Territory, x: number, y: number): number {
  return islandTop + baseTerrainField(p).sample(x, y).elevation;
}
