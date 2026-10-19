import {
  landReading,
  type StructuralTerrain,
  type TerrainSurface,
  terrainLevels,
  terrainLift,
} from "../../lib/visualization/terrain";
import type { TerrainInspection } from "../settings/terrain-inspection";

/** The water level of the land reading: basements and shelves emerge as land. */
export const landReadingLevel = -0.8;

/**
 * Soft depth bands derived from the continuous water depth: each band is a
 * smooth step, never an outline, and the bands follow the terrain rather
 * than rings around any island. `strength` 0 is the continuous depth.
 */
export const depthTerraces = { bands: 8, softness: 0.3, strength: 0.4 };

/** Map units over which the inspected signed distance spans its range. */
const signedDistanceSpan = 200;
/** Lift gradient per map unit, as light: the bevel the shelves had. */
const slopeLight = 24;
/** Elevation gradient per map unit at which the inspected slope saturates. */
const steepSlope = 0.05;

function terraced(depth: number): number {
  const { bands, softness, strength } = depthTerraces;
  const scaled = depth * bands;
  const base = Math.floor(scaled);
  const t = Math.min(
    1,
    Math.max(0, (scaled - base - 0.5 + softness) / (2 * softness))
  );
  const stepped = (base + t * t * (3 - 2 * t)) / bands;
  return depth + (Math.min(1, stepped) - depth) * strength;
}

function inspected(
  inspection: TerrainInspection,
  terrain: StructuralTerrain,
  surface: TerrainSurface,
  index: number,
  slope: number,
  land: Float32Array | undefined
): number {
  const elevation = surface.elevation[index] ?? terrainLevels.abyss;
  const { abyss, waterLevel } = terrainLevels;
  switch (inspection) {
    case "elevation":
      return (elevation - abyss) / (terrainLevels.land - abyss);
    case "water-depth":
      // Dark is deep, as on a chart.
      return 1 - Math.max(0, waterLevel - elevation) / (waterLevel - abyss);
    case "signed-distance":
      return Math.min(
        1,
        Math.max(
          0,
          0.5 +
            (terrain.signedDistance[index] ?? Number.POSITIVE_INFINITY) /
              (2 * signedDistanceSpan)
        )
      );
    case "shelf": {
      const thickness = surface.shelf[index] ?? 0;
      return thickness / (thickness + terrain.settings.shelfHalf);
    }
    case "basement": {
      const thickness = surface.basement[index] ?? 0;
      return thickness / (thickness + terrain.settings.basementHalf);
    }
    case "slope":
      return Math.min(1, slope / steepSlope);
    case "land":
      return land?.[index] ?? 0;
    default:
      return 0;
  }
}

/**
 * Four channels a cell, in the terrain grid's row order: the water's depth
 * level (0 at the coast, 1 at the abyss, softly terraced), the northwest
 * light on its slope (-1 to 1), the inspected field (0 to 1), and 1 where
 * an inspection is shown. Land cells carry no water and no slope; the
 * islands draw over them.
 */
export function terrainRelief(
  terrain: StructuralTerrain,
  surface: TerrainSurface,
  inspection: TerrainInspection = ""
): Float32Array {
  const { cell, height, width } = terrain;
  const lift = Float32Array.from(surface.elevation, terrainLift);
  const land =
    inspection === "land" ? landReading(surface, landReadingLevel) : undefined;
  const channels = new Float32Array(width * height * 4);
  const at = (values: Float32Array, column: number, row: number) =>
    values[
      Math.min(height - 1, Math.max(0, row)) * width +
        Math.min(width - 1, Math.max(0, column))
    ] ?? 0;
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const index = row * width + column;
      const dx =
        (at(lift, column + 1, row) - at(lift, column - 1, row)) / (2 * cell);
      const dy =
        (at(lift, column, row + 1) - at(lift, column, row - 1)) / (2 * cell);
      const ex =
        (at(surface.elevation, column + 1, row) -
          at(surface.elevation, column - 1, row)) /
        (2 * cell);
      const ey =
        (at(surface.elevation, column, row + 1) -
          at(surface.elevation, column, row - 1)) /
        (2 * cell);
      const elevation = surface.elevation[index] ?? terrainLevels.abyss;
      const water = elevation < terrainLevels.waterLevel;
      const depth = water ? 1 - (lift[index] ?? 0) : 0;
      channels[index * 4] = water ? terraced(depth) : 0;
      channels[index * 4 + 1] = water
        ? Math.max(-1, Math.min(1, (dx + dy) * slopeLight))
        : 0;
      channels[index * 4 + 2] = inspected(
        inspection,
        terrain,
        surface,
        index,
        Math.hypot(ex, ey),
        land
      );
      channels[index * 4 + 3] = inspection ? 1 : 0;
    }
  }
  return channels;
}
