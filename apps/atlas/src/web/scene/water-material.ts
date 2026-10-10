import { DataTexture, LinearFilter, MathUtils, type Texture } from "three";
import { float, texture as sampleTexture, uniform, uv } from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";
import type { AtlasData } from "../types";
import { paperSurface } from "./paper-surface";

/** Cells along the wreck mask's longer side. */
const wreckMaskResolution = 256;

/**
 * Where wrecks lie: 1 within 18 map units of a wreck, falling to 0 at 40, on
 * a grid over the sea sheet. The sea thins there so a wreck shows through.
 */
function wreckMask(data: AtlasData): DataTexture {
  const scale = wreckMaskResolution / Math.max(data.width, data.height);
  const width = Math.max(1, Math.round(data.width * scale));
  const height = Math.max(1, Math.round(data.height * scale));
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const mapX = ((x + 0.5) / width - 0.5) * data.width;
      const mapY = ((y + 0.5) / height - 0.5) * data.height;
      const depth = Math.max(
        0,
        ...(data.formerPackages ?? []).map((wreck) =>
          Math.max(
            0,
            Math.min(1, (40 - Math.hypot(mapX - wreck.x, mapY - wreck.y)) / 22)
          )
        )
      );
      pixels[((height - 1 - y) * width + x) * 4] = Math.round(depth * 255);
    }
  }
  const mask = new DataTexture(pixels, width, height);
  mask.magFilter = LinearFilter;
  mask.minFilter = mask.magFilter;
  mask.needsUpdate = true;
  return mask;
}

/**
 * The chart's sea: the painted sea sheet under the shared paper surface, thinned
 * over wrecks as the camera comes in. It is still: nothing in it animates.
 */
export function createWaterMaterial(map: Texture, data: AtlasData) {
  const wrecks = !!data.formerPackages?.length;
  const mask = wrecks ? wreckMask(data) : undefined;
  const wreckReveal = uniform(0.2);
  const material = new MeshStandardNodeMaterial({
    depthWrite: !wrecks,
    map,
    metalness: 0,
    roughness: 0.96,
    transparent: wrecks,
  });
  material.colorNode = paperSurface(sampleTexture(map, uv()).rgb);
  if (mask) {
    material.opacityNode = float(1).sub(
      sampleTexture(mask, uv()).r.mul(0.75).mul(wreckReveal)
    );
  }
  return {
    dispose() {
      material.dispose();
      mask?.dispose();
    },
    material,
    setWreckReveal(pixelsPerUnit: number) {
      wreckReveal.value = MathUtils.clamp((pixelsPerUnit - 0.5) / 2, 0.12, 1);
    },
  };
}
