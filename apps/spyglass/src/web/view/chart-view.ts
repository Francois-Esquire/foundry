import { cameraAngles, readerParams } from "../settings/chart-settings";

export function elevationTilt(elevation: number): number {
  const { max, min } = readerParams.elevation;
  const held = Number.isFinite(elevation)
    ? Math.min(max, Math.max(min, elevation))
    : cameraAngles.chart.elevation;
  return ((90 - held) * Math.PI) / 180;
}

export const chartTilt = elevationTilt(cameraAngles.chart.elevation);

function viewTilt(view: Pick<InkView, "tilt">): number {
  return view.tilt ?? chartTilt;
}

export function viewSquash(view: Pick<InkView, "tilt">): number {
  return Math.cos(viewTilt(view));
}

export interface InkView {
  height: number;
  pixelsPerUnit: number;
  tilt?: number;
  width: number;
  x: number;
  y: number;
}
