import { Mesh, PlaneGeometry } from "three";
import type { Polygon, SpyglassData } from "../data/types";
import { type OceanField, oceanField } from "../layout/ocean-field";
import type { SceneLayer } from "./handle";
import { createWaterMaterial } from "./water-material";

/** Cells across the sea's longer side in its shade field. */
const shadeResolution = 1280;

/**
 * The sea: one plane over the whole sea extent, shaded by its material from
 * two fields. The shade field is measured here over the sea, since the
 * depth steps and the vignette to open water reach far past the chart; the
 * shore field is the chart's own, shared with the ripples and the contours.
 */
export function createSeaLayer(options: {
  /** The chart's extent, which the shore field covers. */
  chart: SpyglassData;
  /** Every coast the depth steps follow, in the chart's coordinates. */
  coasts: Polygon[];
  /** The sea's extent, wider than the chart, which the plane fills. */
  sea: SpyglassData;
  shore: OceanField;
}): SceneLayer {
  const { chart, coasts, sea, shore } = options;
  const shade = oceanField(sea, shadeResolution, coasts);
  const water = createWaterMaterial({ chart, sea, shade, shore });
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
    update: (view) => water.setWreckReveal(view.pixelsPerUnit),
  };
}
