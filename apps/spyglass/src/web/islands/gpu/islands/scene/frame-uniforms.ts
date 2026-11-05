/**
 * The frame's uniforms out of a `Look` and a `View`, as the terrain, water,
 * props and post read them: the frame's side of map-uniforms.ts. Pure, and
 * free of `vgpu` values, so scene.ts only orchestrates.
 */

import { CLIP_CELLS, type ClipLayout, SUBTEXELS } from "../land/clipmap";
import type { DebrisLight } from "../land/debris";
import { VIEWED_MAPS } from "../maps/map-params";
import { frameUniform, type MapFrame } from "../maps/map-uniforms";
import type { PostLook } from "../post/post";
import type { View } from "../view/camera";
import { floorColorOf, type Look } from "./look";

/** 0 for the shaded view, else 1 + the map's index among the viewed (terrain.wgsl `Grid.view`). */
const viewIndex = (view: Look["view"]): number =>
	view === "shaded" ? 0 : VIEWED_MAPS.indexOf(view) + 1;

/** The eye and its aperture, the rays a screen uv casts (water.wgsl `Eye`, pick.wgsl `Pick`). */
export const rayUniform = (view: View) => ({
	eye: view.eye,
	near: view.near,
	forward: view.forward,
	apertureX: view.aperture[0],
	right: view.right,
	apertureY: view.aperture[1],
	up: view.up,
});

/** The terrain's uniforms: both clipmap draws take the same. */
export function terrainUniforms(
	view: View,
	clip: ClipLayout,
	grid: MapFrame,
	look: Look
) {
	return {
		camera: {
			viewProjection: view.viewProjection,
			eye: view.eye,
			time: look.time,
		},
		clip: {
			origin: [clip.origin[0] * SUBTEXELS, clip.origin[1] * SUBTEXELS],
			stride: clip.stride * SUBTEXELS,
			cells: CLIP_CELLS,
		},
		grid: {
			...frameUniform(grid),
			view: viewIndex(look.view),
			ramp: [look.distanceReach, look.floorDepth, look.landTop],
			flowSpeed: look.flowSpeed,
			land: look.land,
		},
		look: {
			sun: look.sun,
			sunStrength: look.sunStrength,
			sunColor: look.sunColor,
			skyStrength: look.skyStrength,
			skyColor: look.skyColor,
			softLight: look.softLight,
			seaFill: look.seaFill,
			shadowStrength: look.shadowStrength,
			rock: look.rock,
			rockTint: look.rockTint,
			bounce: look.bounce,
			bounceStrength: look.bounceStrength,
			ripples: look.ripples,
			rippleSpacing: look.rippleSpacing,
			specks: look.specks,
			speckSize: look.speckSize,
			speck: look.speck,
			speckDensity: look.speckDensity,
			top: look.top,
			occlusion: look.occlusion,
			occlusionSun: look.occlusionSun,
			files: look.files,
			grassLush: look.grassLush,
			grass: look.grass,
			grassDry: look.grassDry,
			grassSheen: look.grassSheen,
			windHeading: look.windHeading,
			wind: look.wind,
			windSpeed: look.windSpeed,
			gustSize: look.gustSize,
		},
	};
}

/** The water composite's uniforms. */
export function waterUniforms(view: View, grid: MapFrame, look: Look) {
	return {
		eye: {
			viewProjection: view.viewProjection,
			...rayUniform(view),
			time: look.time,
		},
		grid: frameUniform(grid),
		highlight: {
			fill: look.highlight,
			outline: look.highlightOutline,
			memberFill: look.highlightMembers,
			dim: look.highlightDim,
			color: look.highlightColor,
		},
		water: {
			absorption: look.absorption,
			enabled: look.water ? 1 : 0,
			clarity: look.clarity,
			depthPower: look.depthPower,
			depthCurve: look.depthCurve,
			shadowAmbient: look.shadowAmbient,
			scatter: look.scatter,
			reflection: look.reflection,
			sun: look.sun,
			specular: look.specular,
			sunColor: look.sunColor,
			refraction: look.refraction,
			horizon: look.skyHorizon,
			waveStrength: look.waveStrength,
			zenith: look.skyZenith,
			haze: look.haze,
			hazeNear: look.hazeNear,
			seaLines: look.seaLines,
			hazeFar: look.hazeFar,
			floorDepth: look.floorDepth,
			floorColor: floorColorOf(look),
			top: look.top,
			seaLine: look.seaLine,
			shoalGlow: look.shoalGlow,
			shoalReach: look.shoalReach,
			surf: look.surf,
			surfSpacing: look.surfSpacing,
			surfSpeed: look.surfSpeed,
			caustics: look.caustics,
			causticSize: look.causticSize,
			legend: look.legend,
			relief: look.relief,
			rim: look.rim,
			refractionReach: look.refractionReach,
			wash: look.wash,
			washWidth: look.washWidth,
			washPeriod: look.washPeriod,
			swash: look.swash,
			swashReach: look.swashReach,
			swashPeriod: look.swashPeriod,
			wetSand: look.wetSand,
			bands: look.bands,
			waves: look.waves,
		},
	};
}

/** What the props are lit and drawn with, into a film of `viewport` pixels. */
export function debrisLightOf(
	view: View,
	look: Look,
	viewport: readonly [number, number]
): DebrisLight {
	return {
		viewProjection: view.viewProjection,
		sun: look.sun,
		sunStrength: look.sunStrength,
		sunColor: look.sunColor,
		skyStrength: look.skyStrength,
		skyColor: look.skyColor,
		shadowStrength: look.shadowStrength,
		occlusion: look.occlusion,
		occlusionSun: look.occlusionSun,
		seaFill: look.seaFill,
		rock: look.rock,
		time: look.time,
		rings: look.water ? look.debrisRings : 0,
		viewport,
	};
}

/** What the post reads of the look. */
export const postLookOf = (look: Look): PostLook => ({
	antialias: look.antialias,
	bloom: look.bloom,
	bloomRadius: look.bloomRadius,
	bloomThreshold: look.bloomThreshold,
	vignette: look.water ? look.vignette : 0,
	vignetteColor: look.vignetteColor,
});
