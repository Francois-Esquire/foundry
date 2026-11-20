import type { Rgb } from "../sea/sea-params";
import type { MapParams } from "./map-params";

export const clamp01 = (x: number): number => Math.min(Math.max(x, 0), 1);

export const landUniform = (
  params: Pick<
    MapParams,
    | "crownHeight"
    | "crownWidth"
    | "lipHeight"
    | "lipWidth"
    | "plateHeight"
    | "rimWidth"
  >
) => ({
  crownHeight: params.crownHeight,
  crownWidth: params.crownWidth,
  lipHeight: params.lipHeight,
  lipWidth: params.lipWidth,
  plateHeight: params.plateHeight,
  rimWidth: params.rimWidth,
});

export function sunDirection(azimuth: number, elevation: number): Rgb {
  const flat = Math.cos(elevation);
  return [
    Math.sin(azimuth) * flat,
    Math.sin(elevation),
    -Math.cos(azimuth) * flat,
  ];
}
