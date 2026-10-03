import type { Texture } from "three";
import {
  attribute,
  color,
  float,
  materialColor,
  mix,
  uniform,
} from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";

import { paperSurface, terrainGrid } from "./paper-surface";

export const paperThickness = 0.4;

/** Full occlusion strength darkens a valley floor by this fraction. */
const reliefShade = 0.24;

/**
 * Paper is engraved: the relief carries a per-vertex occlusion term (see
 * terrainGeometry) that this material darkens with, so valleys and the foot
 * of hills read as shading on the direct draw and in the pipeline alike.
 */
export function createPaperMaterials(map: Texture) {
  const strength = uniform(0);
  const paper = new MeshStandardNodeMaterial({
    map,
    metalness: 0,
    roughness: 0.96,
  });
  const occlusion = attribute<"float">("occlusion", "float");
  paper.colorNode = terrainGrid(
    paperSurface(
      mix(
        materialColor.rgb,
        color("#874d38"),
        attribute<"float">("mineral", "float")
      )
    )
  ).mul(float(1).sub(occlusion.mul(strength).mul(reliefShade)));
  return {
    dispose: () => {
      paper.dispose();
    },
    paper,
    /** Occlusion strength; zero removes valley darkening, retaining slope shading. */
    setOcclusion: (value: number) => {
      strength.value = value;
    },
  };
}
