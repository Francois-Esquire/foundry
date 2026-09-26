import * as THREE from "three";

export const paperThickness = 0.4;

export function createPaperMaterials(map: THREE.Texture) {
  const paper = new THREE.MeshStandardMaterial({
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
