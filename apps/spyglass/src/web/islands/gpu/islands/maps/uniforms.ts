/** Shared land and lighting uniforms for the map bake and the frame. */

import type { Rgb } from "../sea/sea-params";
import type { MapParams } from "./map-params";

/** x held to 0–1. */
export const clamp01 = (x: number): number => Math.min(Math.max(x, 0), 1);

/** The land's profile (land.wgsl `Land`): the height map's and the terrain's. */
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
	plateHeight: params.plateHeight,
	rimWidth: params.rimWidth,
	lipHeight: params.lipHeight,
	lipWidth: params.lipWidth,
	crownHeight: params.crownHeight,
	crownWidth: params.crownWidth,
});

/**
 * Toward the sun from an azimuth (radians clockwise from north, chart −y,
 * which is world −z) and an elevation, world space.
 */
export function sunDirection(azimuth: number, elevation: number): Rgb {
	const flat = Math.cos(elevation);
	return [
		Math.sin(azimuth) * flat,
		Math.sin(elevation),
		-Math.cos(azimuth) * flat,
	];
}
