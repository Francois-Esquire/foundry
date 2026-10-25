import {
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
} from "three";
import type { StructuralTerrain } from "../../lib/visualization/terrain";
import { terrainRelief } from "../layout/terrain-relief";
import type { TerrainInspection } from "../settings/terrain-inspection";

export interface TerrainView {
  /** A group, dependency, or internal foundation to isolate; empty for all. */
  focus: string;
  /** Off leaves each island's own descent: the seabed without relationships. */
  foundations: boolean;
  inspection: TerrainInspection;
}

/**
 * The structural terrain as one half-float texture over its grid, rows
 * turned so the grid's first row, the chart's top, is the texture's top.
 * Changing the view recomposes from the terrain's cached contributions and
 * rewrites this texture's texels; it never rebuilds geometry and never runs
 * per frame.
 */
export function createTerrainTexture(terrain: StructuralTerrain) {
  const { height, width } = terrain;
  const data = new Uint16Array(width * height * 4);
  const texture = new DataTexture(
    data,
    width,
    height,
    RGBAFormat,
    HalfFloatType
  );
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  let shown = "";
  const show = (view: TerrainView) => {
    const key = JSON.stringify(view);
    if (key === shown) {
      return;
    }
    shown = key;
    const relief = terrainRelief(
      terrain,
      terrain.compose({ focus: view.focus, foundations: view.foundations }),
      view.inspection
    );
    const rowLength = width * 4;
    for (let row = 0; row < height; row += 1) {
      const from = row * rowLength;
      const to = (height - 1 - row) * rowLength;
      for (let i = 0; i < rowLength; i += 1) {
        data[to + i] = DataUtils.toHalfFloat(relief[from + i] ?? 0);
      }
    }
    texture.needsUpdate = true;
  };
  show({ focus: "", foundations: true, inspection: "" });
  return {
    /** The extent the texture covers, in map units about the chart's centre. */
    extent: { height: height * terrain.cell, width: width * terrain.cell },
    show,
    texture,
  };
}
