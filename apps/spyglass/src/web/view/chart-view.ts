import type { OrthographicCamera, Vector3 } from "three";

import type { SpyglassFile } from "../data/types";
import { cameraAngles, cameraElevationRange } from "../settings/chart-settings";

/**
 * The camera's tilt off the vertical, in radians, for an elevation above the
 * horizon in degrees: 0 looks straight down. The elevation is held within
 * the range a reader may set, so the tilt never reaches the horizon, where
 * the chart's north–south would foreshorten to nothing; one that is not a
 * number is the chart's own.
 */
export function elevationTilt(elevation: number): number {
  const { max, min } = cameraElevationRange;
  const held = Number.isFinite(elevation)
    ? Math.min(max, Math.max(min, elevation))
    : cameraAngles.chart.elevation;
  return ((90 - held) * Math.PI) / 180;
}

/** The camera's default tilt off the vertical, 0.7 radians: the chart's north–south runs foreshortened by its cosine on screen. */
export const chartTilt = elevationTilt(cameraAngles.chart.elevation);

/** Extra water permits panning without making the chart smaller at maximum zoom-out. */
export function chartSeaBounds(chart: { height: number; width: number }) {
  const panRoom = 2.2;
  return {
    height: chart.height * 1.65 * panRoom,
    panRoom,
    width: chart.width * 1.95 * panRoom,
  };
}

/** Missing tilt identifies legacy flat-annotation callers. Live views always publish the camera's current tilt. */
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
  /** Camera angle off vertical, in radians. */
  tilt?: number;
  width: number;
  x: number;
  y: number;
}
