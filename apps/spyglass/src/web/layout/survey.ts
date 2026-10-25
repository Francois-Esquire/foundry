import { terrainSilhouette } from "../../lib/visualization/terrain";
import type { SpyglassData } from "../data/types";
import type { ChartSettings } from "../settings/chart-settings";
import { spyglassBoundaries } from "./boundaries";
import { chartTerrain } from "./chart-terrain";
import { continentCoasts, createContinents } from "./continent";
import { oceanField } from "./ocean-field";
import { createSeaRipples } from "./sea-ripples";
import { createTopography } from "./topography";

/** Cells across the chart's longer side in the shore field. */
const shoreResolution = 1280;

/**
 * The layout the scene draws from the geometry, once: the structural
 * terrain and its outer silhouette, connecting land where the land layer is
 * on, the shore field every coast is measured from, the sea's ripples and
 * the contours off every coast, and the developer's boundary outlines.
 */
export function surveyChart(
  data: SpyglassData,
  coastalBuffer: number,
  layers: ChartSettings["layers"]
) {
  const footprints = createContinents(data, coastalBuffer);
  const continents = layers.land ? footprints : [];
  const coasts = continentCoasts(data, continents);
  const terrain = chartTerrain(data);
  const silhouette = terrainSilhouette(terrain);
  const shore = oceanField(data, shoreResolution, coasts, silhouette);
  return {
    boundaries: spyglassBoundaries(
      data,
      coastalBuffer,
      footprints.map((c) => c.field),
      terrain
    ),
    /** Every coast the sea is measured from: the continents' outlines and each island's. */
    coasts,
    continents,
    ripples: createSeaRipples(data, shore),
    /** Distances off every coast and beyond the silhouette, over the chart. */
    shore,
    /** The terrain's outer silhouette, which the open sea is measured from. */
    silhouette,
    terrain,
    topography: createTopography(data, shore),
  };
}
