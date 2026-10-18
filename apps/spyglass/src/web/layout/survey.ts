import type { SpyglassData } from "../data/types";
import type { ChartSettings } from "../settings/chart-settings";
import { spyglassBoundaries } from "./boundaries";
import { continentCoasts, createContinents } from "./continent";
import { createSeaRipples } from "./sea-ripples";
import { createTopography } from "./topography";

/**
 * The layout the scene draws from the geometry, once: connecting land where
 * the land layer is on, the sea's ripples and the contours off every coast,
 * and the developer's boundary outlines.
 */
export function surveyChart(
  data: SpyglassData,
  coastalBuffer: number,
  layers: ChartSettings["layers"]
) {
  const footprints = createContinents(data, coastalBuffer);
  const continents = layers.land ? footprints : [];
  const coasts = continentCoasts(data, continents);
  return {
    boundaries: spyglassBoundaries(
      data,
      coastalBuffer,
      footprints.map((c) => c.field)
    ),
    continents,
    ripples: createSeaRipples(data, coasts),
    topography: createTopography(data, coasts),
  };
}
