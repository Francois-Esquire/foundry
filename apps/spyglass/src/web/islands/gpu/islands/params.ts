/**
 * The settings: the dataset and view, the land's map parameters (named as
 * in `MapParams`, so look.ts `mapParamsOf` picks them straight out), the
 * frame, and the sea (sea-settings.ts, named as in `SeaParams`:
 * bathymetry, floor, flow, surface, shore). Groups run in that order down
 * the sidebar.
 */
import type { ParamValues } from "../../lab/params";
import { defineParams, param } from "../../lab/params";
import { DEFAULT_MAP_PARAMS, VIEWED_MAPS } from "./maps/map-params";
import { seaSettings } from "./sea/sea-settings";

export const ISLANDS_DATASETS = ["foundry"] as const;
export const ISLANDS_VIEWS = ["shaded", ...VIEWED_MAPS] as const;
export const ISLANDS_RESOLUTIONS = ["512", "1024", "2048"] as const;
export const ISLANDS_PALETTES = ["order", "hash"] as const;

const TURN = 2 * Math.PI;

const MAP = DEFAULT_MAP_PARAMS;

export const islandsParams = defineParams({
	dataset: param.select(ISLANDS_DATASETS, "foundry", {
		hint: "Foundry's own workspace, through its adapter",
	}),
	view: param.select(ISLANDS_VIEWS, "shaded", {
		hint: "shaded: the paint lit, with water; or any one map draped over the terrain",
	}),

	// Distance.
	tileWorldSize: param.number({
		label: "bake tile span",
		hint: "World units per tile; 0 preserves chart-fitted maps",
		min: 0,
		max: 8192,
		step: 128,
		value: MAP.tileWorldSize,
	}),
	resolution: param.select(ISLANDS_RESOLUTIONS, `${MAP.resolution}`, {
		hint: "texels a side of every map",
	}),
	// Coverage.
	feather: param.number({
		hint: "coverage: texels across the coast's ease",
		min: 0.25,
		max: 8,
		step: 0.25,
		value: MAP.feather,
	}),
	// Height, chart units: the land (the sea's floor is the sea's).
	plateHeight: param.number({
		label: "plate height",
		hint: "height: the land's flat top above sea level",
		min: 0.5,
		max: 40,
		step: 0.5,
		value: MAP.plateHeight,
	}),
	rimWidth: param.number({
		label: "rim width",
		hint: "height: the rise from the coast to the plate",
		min: 0.25,
		max: 20,
		step: 0.25,
		value: MAP.rimWidth,
	}),
	rimSmoothing: param.number({
		label: "rim smoothing",
		hint: "height: the rim follows the coast's course without its finest wiggles, chart units; 0 for none",
		min: 0,
		max: 10,
		step: 0.25,
		value: MAP.rimSmoothing,
	}),
	lipHeight: param.number({
		label: "lip height",
		hint: "height: a thin raised band along the edge",
		min: 0,
		max: 4,
		step: 0.1,
		value: MAP.lipHeight,
	}),
	lipWidth: param.number({
		label: "lip width",
		min: 0,
		max: 10,
		step: 0.25,
		value: MAP.lipWidth,
	}),
	crownHeight: param.number({
		label: "crown height",
		hint: "height: the top's swell over the plate, like a bun's",
		min: 0,
		max: 12,
		step: 0.25,
		value: MAP.crownHeight,
	}),
	crownWidth: param.number({
		label: "crown width",
		hint: "height: how far inland the crown rises most of the way",
		min: 1,
		max: 60,
		step: 0.5,
		value: MAP.crownWidth,
	}),
	// Light.
	sunAzimuth: param.number({
		label: "sun azimuth",
		hint: "light: radians clockwise from north",
		min: 0,
		max: TURN,
		step: 0.01,
		value: MAP.sunAzimuth,
	}),
	sunElevation: param.number({
		label: "sun elevation",
		hint: "light: radians above the horizon",
		min: 0.05,
		max: 1.5,
		step: 0.01,
		value: MAP.sunElevation,
	}),
	// Paint.
	palette: param.select(ISLANDS_PALETTES, MAP.palette, {
		label: "palette",
		hint: "paint: which pastel cap an island takes, by island order or by a hash of its id",
	}),
	grass: param.number({
		label: "grass",
		hint: "the turf on the tops in place of the islands' caps, 0–1",
		min: 0,
		max: 1,
		step: 0.05,
		value: 1,
	}),
	grassLush: param.color("#4f8a2e", {
		label: "grass lush",
		hint: "the turf's deep green, in hollows and lush patches",
	}),
	grassDry: param.color("#a9b45a", {
		label: "grass dry",
		hint: "the turf's sunbleached green, at the edges and dry patches",
	}),
	grassSheen: param.number({
		label: "grass sheen",
		hint: "the turf's pale glow toward a grazing eye",
		min: 0,
		max: 2,
		step: 0.05,
		value: 0.6,
	}),
	wind: param.number({
		label: "wind",
		hint: "how hard the wind lays the turf over, blowing the swell's way, 0 for still",
		min: 0,
		max: 2,
		step: 0.05,
		value: 1,
	}),
	windSpeed: param.number({
		label: "wind speed",
		hint: "how fast the gusts run over the turf, chart units a second",
		min: 0,
		max: 40,
		step: 0.5,
		value: 9,
	}),
	gustSize: param.number({
		label: "gust size",
		hint: "how long a gust runs along the wind, chart units",
		min: 4,
		max: 120,
		step: 1,
		value: 34,
	}),
	rockColor: param.color("#b08878", {
		label: "rock colour",
		hint: "the cliff rock on the land's steep rim",
	}),
	rockTint: param.number({
		label: "rock tint",
		hint: "how far the rock takes its island's hue, 0–1",
		min: 0,
		max: 1,
		step: 0.05,
		value: 0.35,
	}),

	// Files.
	fileRadius: param.number({
		label: "file radius",
		hint: "files: each file's disc on its island, chart units (the files view)",
		min: 0.5,
		max: 6,
		step: 0.25,
		value: MAP.fileRadius,
	}),
	fileStrength: param.number({
		label: "file strength",
		hint: "files: how strongly the files show on the shaded ground; 0 hides them (the town carries them)",
		min: 0,
		max: 1,
		step: 0.05,
		value: 0,
	}),

	// Frame.
	renderScale: param.number({
		label: "render scale",
		hint: "the film's size against the canvas; the composite upsamples",
		min: 0.25,
		max: 1,
		step: 0.05,
		value: 1,
	}),
	sunStrength: param.number({
		label: "sun strength",
		hint: "light: the key, scaled so a flat sunlit face keeps its brightness at any elevation",
		min: 0,
		max: 2,
		step: 0.02,
		value: 0.78,
	}),
	sunWarmth: param.number({
		label: "sun warmth",
		hint: "light: how golden a low sun is; 0 neutral white",
		min: 0,
		max: 1.5,
		step: 0.05,
		value: 0.5,
	}),
	skyFill: param.number({
		label: "sky fill",
		hint: "light: the fill everywhere, shadows included",
		min: 0,
		max: 1.5,
		step: 0.02,
		value: 0.58,
	}),
	skyColor: param.color("#93b2da", {
		label: "sky colour",
		hint: "light: the fill from above under a low sun; it goes neutral toward noon",
	}),
	seaFill: param.color("#6a8c9c", {
		label: "sea fill",
		hint: "light: the fill from below, off the sea, on undersides and lee faces",
	}),
	softLight: param.number({
		label: "soft light",
		hint: "light: wraps the sun round gentle ground, so tops read smooth while cliffs keep their shadow side",
		min: 0,
		max: 1,
		step: 0.05,
		value: 0.45,
	}),
	shadowStrength: param.number({
		label: "shadow strength",
		hint: "light: how much sun a cast shadow takes away; 1 all of it",
		min: 0,
		max: 1,
		step: 0.05,
		value: 0.6,
	}),
	occlusion: param.number({
		hint: "light: how deep the baked ambient occlusion sits in creases and at the feet of walls; 1 as baked",
		min: 0,
		max: 4,
		step: 0.05,
		value: 1.6,
	}),
	occlusionSun: param.number({
		label: "occlusion in sun",
		hint: "light: the share of the ambient occlusion the sun takes too, so the ground stays grounded in full light; 0 fill only",
		min: 0,
		max: 1,
		step: 0.05,
		value: 0.35,
	}),
	bounce: param.number({
		hint: "light: warm light thrown up off sunlit sand and shallows onto cliffs and island bases",
		min: 0,
		max: 2,
		step: 0.05,
		value: 0.9,
	}),
	bounceColor: param.color("#ffe0b0", {
		label: "bounce colour",
		hint: "light: the colour of the light off sunlit sand",
	}),
	// Post: after the water, over the whole frame.
	bloom: param.number({
		hint: "post: a soft glow round what is brighter than the threshold, glints and sunlit foam; 0 for none",
		min: 0,
		max: 2,
		step: 0.02,
		value: 0.3,
	}),
	bloomThreshold: param.number({
		label: "bloom threshold",
		hint: "post: the linear brightness the bloom starts at, eased in below it",
		min: 0,
		max: 2,
		step: 0.02,
		value: 0.85,
	}),
	bloomRadius: param.number({
		label: "bloom radius",
		hint: "post: how wide the bloom spreads; wider leans on its deeper levels",
		min: 0,
		max: 2,
		step: 0.05,
		value: 1,
	}),
	antialias: param.toggle(true, {
		label: "anti-aliasing",
		hint: "post: FXAA over the finished frame, smoothing the land's and the foam's edges",
	}),
	vignette: param.number({
		hint: "the margins darken toward the vignette's warm sepia; 0 for none",
		min: 0,
		max: 1,
		step: 0.02,
		value: 0.36,
	}),
	vignetteColor: param.color("#c7b399", {
		label: "vignette colour",
		hint: "the tint the margins darken toward",
	}),
	// Selection: click an island or a ring to choose it, Escape to let go.
	selection: param.toggle(true, {
		hint: "selection: click an island or a ring to choose it, hover to outline; off lets go and stops picking",
	}),
	highlight: param.number({
		hint: "selection: how much the chosen island or ring lightens",
		min: 0,
		max: 1,
		step: 0.02,
		value: 0.4,
	}),
	highlightOutline: param.number({
		label: "highlight outline",
		hint: "selection: the outline round the chosen and the hovered; 0 for none",
		min: 0,
		max: 1,
		step: 0.02,
		value: 0.9,
	}),
	highlightMembers: param.number({
		label: "highlight members",
		hint: "selection: how much a chosen ring's islands lighten, against its plates",
		min: 0,
		max: 1,
		step: 0.02,
		value: 0.5,
	}),
	highlightDim: param.number({
		label: "highlight dim",
		hint: "selection: how much the rest darkens while something is chosen",
		min: 0,
		max: 1,
		step: 0.02,
		value: 0.3,
	}),
	highlightColor: param.color("#fff3cf", {
		label: "highlight colour",
		hint: "selection: the fill's and the outline's colour",
	}),

	// The sea: bathymetry, floor and flow are baked into the maps; surface
	// and shore are the frame's.
	...seaSettings,
});

export type IslandsSettings = ParamValues<typeof islandsParams>;
