import { CanvasTexture, LinearFilter, SRGBColorSpace } from "three";

/** Viewport ink is redrawn at its display resolution; it needs no mip pyramid. */
export function createInkTexture(canvas: HTMLCanvasElement) {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  return texture;
}
