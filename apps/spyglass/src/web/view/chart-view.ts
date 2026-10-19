import type { OrthographicCamera, Vector3 } from "three";

import type { SpyglassFile } from "../data/types";

/** The camera's tilt off the vertical, in radians: the chart's north–south runs foreshortened by its cosine on screen. */
export const chartTilt = 0.7;

/** The dimensional end of the continuous atlas-to-diorama camera. */
export const dioramaTilt = (55 * Math.PI) / 180;

/** Missing tilt identifies legacy flat-annotation callers. Live views always publish it. */
function viewTilt(view: Pick<InkView, "tilt">): number {
  return view.tilt ?? chartTilt;
}

export function viewSquash(view: Pick<InkView, "tilt">): number {
  return Math.cos(viewTilt(view));
}

export function zoomForPixels(
  camera: OrthographicCamera,
  viewportWidth: number,
  pixelsPerUnit: number
) {
  return ((camera.right - camera.left) * pixelsPerUnit) / viewportWidth;
}

export function keepSeaInFrame(
  camera: OrthographicCamera,
  target: Vector3,
  tilt: number,
  width: number,
  height: number,
  panWidth = width,
  panHeight = height,
  zoomOutFactor = 1
) {
  const minZoom =
    Math.max(
      (camera.right - camera.left) / width,
      (camera.top - camera.bottom) / (height * Math.cos(tilt))
    ) *
    1.02 *
    zoomOutFactor;
  if (camera.zoom < minZoom) {
    camera.zoom = minZoom;
    camera.updateProjectionMatrix();
  }
  const xLimit = Math.min(
    (width - (camera.right - camera.left) / camera.zoom) / 2,
    panWidth / 2
  );
  const yLimit = Math.min(
    (height - (camera.top - camera.bottom) / camera.zoom / Math.cos(tilt)) / 2,
    panHeight / 2
  );
  const x = Math.max(-xLimit, Math.min(xLimit, target.x));
  const groundY = target.y + target.z * Math.tan(tilt);
  const y = Math.max(-yLimit, Math.min(yLimit, groundY));
  camera.position.x += x - target.x;
  camera.position.y += y - target.y;
  camera.position.z -= target.z;
  target.set(x, y, 0);
  return minZoom;
}

export function inkView(
  camera: OrthographicCamera,
  target: Vector3,
  tilt: number,
  elevation: number,
  viewportWidth: number
): InkView {
  const width = (camera.right - camera.left) / camera.zoom;
  return {
    height: (camera.top - camera.bottom) / camera.zoom / Math.cos(tilt),
    pixelsPerUnit: viewportWidth / width,
    tilt,
    width,
    x: target.x,
    y: -target.y + (elevation - target.z) * Math.tan(tilt),
  };
}

export function frameFiles(files: SpyglassFile[]) {
  if (!files.length) {
    return null;
  }
  const left = Math.min(...files.map((f) => f.x));
  const right = Math.max(...files.map((f) => f.x));
  const top = Math.min(...files.map((f) => f.y));
  const bottom = Math.max(...files.map((f) => f.y));
  return {
    height: Math.max(36, bottom - top + 24),
    width: Math.max(36, right - left + 24),
    x: (left + right) / 2,
    y: (top + bottom) / 2,
  };
}

export interface InkView {
  height: number;
  pixelsPerUnit: number;
  /** Current animated atlas-to-diorama presentation, when supplied by the live camera. */
  presentation?: number;
  /** Camera angle off vertical, in radians. */
  tilt?: number;
  width: number;
  x: number;
  y: number;
}
