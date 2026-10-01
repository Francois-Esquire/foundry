import type { Texture } from "three";
import {
  attribute,
  dot,
  float,
  materialColor,
  max,
  mix,
  normalLocal,
  uniform,
  vec3,
} from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";

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
  const paper = new MeshBasicNodeMaterial({
    map,
  });
  const occlusion = attribute<"float">("occlusion", "float");
  // Cool shadow and warm light describe the measured density slopes. Quiet
  // flats leave enough value range for settlement ink and water.
  const aspect = dot(normalLocal, vec3(-0.65, 0.65, 0)).clamp(-1, 1);
  const shadow = max(0, aspect.negate()).mul(0.62);
  const lit = max(0, aspect).mul(0.08);
  const pigment = mix(materialColor.rgb, vec3(0.3, 0.36, 0.34), shadow);
  paper.colorNode = mix(pigment, vec3(1, 0.96, 0.84), lit).mul(
    float(1).sub(occlusion.mul(strength).mul(reliefShade))
  );
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
