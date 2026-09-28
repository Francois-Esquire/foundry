import { MeshStandardMaterial, type Texture } from "three";

export const paperThickness = 0.4;

export function createPaperMaterials(map: Texture) {
  const paper = new MeshStandardMaterial({
    map,
    metalness: 0,
    roughness: 0.96,
  });
  return {
    dispose: () => {
      paper.dispose();
    },
    paper,
  };
}
