import {
  type StructuralTerrain,
  structuralTerrain,
  terrainContributions,
} from "../../lib/visualization/terrain";
import type { SpyglassData } from "../data/types";

/**
 * The chart's structural terrain, from its settled islands and their
 * relationships. Layout is finished before this is read, and nothing here
 * moves an island. Built once per layout and cached by content.
 */
export function chartTerrain(
  data: Pick<
    SpyglassData,
    | "foundationGroups"
    | "foundations"
    | "height"
    | "internalFoundations"
    | "territories"
    | "width"
  >
): StructuralTerrain {
  return structuralTerrain({
    contributions: terrainContributions(
      data.foundationGroups ?? [],
      data.foundations ?? [],
      data.internalFoundations ?? []
    ),
    extent: { height: data.height, width: data.width },
    islands: data.territories,
  });
}
