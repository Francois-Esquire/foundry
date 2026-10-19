import { Mesh, PlaneGeometry } from "three";
import type { Polygon, SpyglassData } from "../data/types";
import { type OceanField, oceanField, rimField } from "../layout/ocean-field";
import { isSceneLayerVisible } from "../settings/scene-composition";
import type { SceneLayer } from "./handle";
import { createWaterMaterial } from "./water-material";
import { surfBand, type WeatherNodes } from "./weather";

/** Cells across the sea's longer side in its shade field, and across the surf's extent in its rim field. */
const shadeResolution = 1280;

/**
 * The extent the surf's rim field covers: the chart's, grown where a rim
 * reaches past it, with room for the band and a cell of filtering beyond
 * the rim's farthest point. A rim lies within the chart on the reference
 * workspace but for a few units at its top.
 */
function surfExtent(
  chart: Pick<SpyglassData, "height" | "width">,
  rims: OceanField["rims"]
) {
  let reachX = 0;
  let reachY = 0;
  for (const rim of rims) {
    for (const [x, y] of rim) {
      reachX = Math.max(reachX, Math.abs(x));
      reachY = Math.max(reachY, Math.abs(y));
    }
  }
  const room = 2 * (surfBand.reach + 4);
  return {
    height: Math.max(chart.height, 2 * reachY + room),
    width: Math.max(chart.width, 2 * reachX + room),
  };
}

/**
 * The sea: one plane over the whole sea extent, shaded by its material from
 * three fields. The shade field is measured here over the sea, since the
 * depth steps and the vignette to open water reach far past the chart; the
 * shore field is the chart's own, shared with the ripples and the contours;
 * the rim field is the surf's, measured here over the chart grown to hold
 * every rim.
 */
export function createSeaLayer(options: {
  /** The chart's extent, which the shore field covers. */
  chart: SpyglassData;
  /** Every coast the depth steps follow, in the chart's coordinates. */
  coasts: Polygon[];
  /** The sea's extent, wider than the chart, which the plane fills. */
  sea: SpyglassData;
  shore: OceanField;
  /** The scene's weather, which the water reads for rim surf and subsurface drift. */
  weather: WeatherNodes;
}): SceneLayer {
  const { chart, coasts, sea, shore, weather } = options;
  const shade = oceanField(sea, shadeResolution, coasts);
  const rim = rimField(
    shade.rims,
    surfExtent(chart, shade.rims),
    shadeResolution
  );
  const water = createWaterMaterial({
    chart,
    rim,
    sea,
    shade,
    shore,
    weather,
  });
  const plane = new Mesh(
    new PlaneGeometry(sea.width, sea.height),
    water.material
  );
  return {
    dispose() {
      plane.geometry.dispose();
      water.dispose();
    },
    group: plane,
    id: "sea",
    kind: "layer",
    update(view, state) {
      water.configure(state.settings.composition);
      water.setWreckReveal(
        view.pixelsPerUnit,
        isSceneLayerVisible(state.settings.composition, "wrecks")
      );
    },
  };
}
