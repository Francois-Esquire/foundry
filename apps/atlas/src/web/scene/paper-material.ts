import type { Texture } from "three";
import { attribute, float, materialColor, uniform } from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { inkAlpha } from "./ink-ladder";
import { paperSurface, terrainGrid } from "./paper-surface";

export const paperThickness = 0.4;

/** Lit matte paper lets the terrain's slopes and valleys carry its relief. */
export function createPaperMaterials(map: Texture) {
  const strength = uniform(1);
  const paper = new MeshStandardNodeMaterial({
    map,
    metalness: 0,
    roughness: 0.96,
  });
  const occlusion = attribute<"float">("occlusion", "float");
  paper.colorNode = terrainGrid(paperSurface(materialColor.rgb)).mul(
    float(1).sub(occlusion.mul(strength).mul(inkAlpha.valleyShade))
  );
  return {
    dispose: () => {
      paper.dispose();
    },
    paper,
    setOcclusion: (value: number) => {
      strength.value = value;
    },
  };
}
