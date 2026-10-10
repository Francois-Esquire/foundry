import type { Texture } from "three";
import {
  attribute,
  clamp,
  float,
  materialColor,
  max,
  normalize,
  normalWorld,
  vec3,
} from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { inkAlpha } from "./ink-ladder";
import { paperSurface, terrainGrid } from "./paper-surface";

export const paperThickness = 0.4;

/** The chart's light: from the north-west, above, as the scene's own light is placed. */
const hillshadeLight = normalize(vec3(-600, 700, 700));

/**
 * The island paper, unlit: its colour is its own, and relief is one term.
 * Slopes turned from the light, and the concavity each vertex carries (see
 * terrainGeometry), darken the paper by at most the ladder's relief cap, so
 * relief never reads darker than a file mark on the direct draw or in the
 * pipeline.
 */
export function createPaperMaterials(map: Texture) {
  const paper = new MeshBasicNodeMaterial({ map });
  const level = hillshadeLight.z;
  const turned = clamp(
    level.sub(normalWorld.dot(hillshadeLight)).div(level),
    0,
    1
  );
  const relief = clamp(
    max(turned, attribute<"float">("occlusion", "float")),
    0,
    1
  );
  paper.colorNode = terrainGrid(paperSurface(materialColor.rgb)).mul(
    float(1).sub(relief.mul(inkAlpha.reliefCap))
  );
  return {
    dispose: () => {
      paper.dispose();
    },
    paper,
  };
}
