import {
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
} from "three";
import type { SpyglassData } from "../data/types";
import type { Continent } from "../layout/continent";
import type { SceneLayer } from "./handle";
import { paintCoast, paintSea } from "./paint-map";
import { createWaterMaterial } from "./water-material";

/** Largest chart texture edge; every supported backend allows at least this. */
export const maxTextureSize = 4096;

function paintSheet(
  source: SpyglassData,
  anisotropy: number,
  paint: (canvas: HTMLCanvasElement) => void
) {
  const canvas = document.createElement("canvas");
  canvas.width = maxTextureSize;
  canvas.height = Math.round((canvas.width * source.height) / source.width);
  paint(canvas);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = anisotropy;
  return texture;
}

/**
 * The two sheets painted once when the scene opens, each on its plane: the
 * sea, over the whole sea extent under the water material, and the coast,
 * over the chart. Phase 5 replaces both with GPU materials.
 */
export function createSheetLayers(options: {
  anisotropy: number;
  continents: Continent[];
  data: SpyglassData;
  /** The sea's extent, wider than the chart, which the sea sheet fills. */
  sea: SpyglassData;
}) {
  const { anisotropy, continents, data, sea } = options;
  const seaTexture = paintSheet(sea, anisotropy, (canvas) =>
    paintSea(canvas, sea, continents)
  );
  const coastTexture = paintSheet(data, anisotropy, (canvas) =>
    paintCoast(canvas, data, continents)
  );
  const water = createWaterMaterial(seaTexture, sea);
  const seaPlane = new Mesh(
    new PlaneGeometry(sea.width, sea.height),
    water.material
  );
  const coastMaterial = new MeshBasicMaterial({
    depthWrite: false,
    map: coastTexture,
    transparent: true,
  });
  const coastPlane = new Mesh(
    new PlaneGeometry(data.width, data.height),
    coastMaterial
  );
  coastPlane.position.z = 0.01;
  const seaLayer: SceneLayer = {
    dispose() {
      seaPlane.geometry.dispose();
      water.dispose();
      seaTexture.dispose();
    },
    group: seaPlane,
    id: "sea",
    update: (view) => water.setWreckReveal(view.pixelsPerUnit),
  };
  const coastLayer: SceneLayer = {
    dispose() {
      coastPlane.geometry.dispose();
      coastMaterial.dispose();
      coastTexture.dispose();
    },
    group: coastPlane,
    id: "coast",
  };
  return {
    coast: coastLayer,
    /** The coast sheet, which the paper materials sample for the land's pigment. */
    coastTexture,
    sea: seaLayer,
    /** The sea sheet's pixel size, which the ink canvases open at. */
    size: { height: seaTexture.image.height, width: seaTexture.image.width },
  };
}
