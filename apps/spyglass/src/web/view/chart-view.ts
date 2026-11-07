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

/** Missing tilt identifies legacy flat-annotation callers. Live views always publish the camera's current tilt. */
function viewTilt(view: Pick<InkView, "tilt">): number {
  return view.tilt ?? chartTilt;
}

export function viewSquash(view: Pick<InkView, "tilt">): number {
  return Math.cos(viewTilt(view));
}

/**
 * The view the labels, the chrome and the margins read: the chart point at
 * the canvas's centre, the extent the canvas covers there in chart units,
 * how many CSS pixels a unit spans, and the camera's tilt. The map works it
 * out from Islands' camera (`islands-host/map-view.ts` `inkViewOf`).
 */
export interface InkView {
  height: number;
  pixelsPerUnit: number;
  /** Camera angle off vertical, in radians. */
  tilt?: number;
  width: number;
  x: number;
  y: number;
}
