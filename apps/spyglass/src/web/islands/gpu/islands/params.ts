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

const ISLANDS_DATASETS = ["foundry"] as const;
export const ISLANDS_VIEWS = ["shaded", ...VIEWED_MAPS] as const;
const ISLANDS_RESOLUTIONS = ["512", "1024", "2048"] as const;
const ISLANDS_PALETTES = ["order", "hash"] as const;

const TURN = 2 * Math.PI;

const MAP = DEFAULT_MAP_PARAMS;

export const islandsParams = defineParams({
  antialias: param.toggle(true, {
    hint: "post: FXAA over the finished frame, smoothing the land's and the foam's edges",
    label: "anti-aliasing",
  }),
  // Post: after the water, over the whole frame.
  bloom: param.number({
    hint: "post: a soft glow round what is brighter than the threshold, glints and sunlit foam; 0 for none",
    max: 2,
    min: 0,
    step: 0.02,
    value: 0.3,
  }),
  bloomRadius: param.number({
    hint: "post: how wide the bloom spreads; wider leans on its deeper levels",
    label: "bloom radius",
    max: 2,
    min: 0,
    step: 0.05,
    value: 1,
  }),
  bloomThreshold: param.number({
    hint: "post: the linear brightness the bloom starts at, eased in below it",
    label: "bloom threshold",
    max: 2,
    min: 0,
    step: 0.02,
    value: 0.85,
  }),
  bounce: param.number({
    hint: "light: warm light thrown up off sunlit sand and shallows onto cliffs and island bases",
    max: 2,
    min: 0,
    step: 0.05,
    value: 0.9,
  }),
  bounceColor: param.color("#ffe0b0", {
    hint: "light: the colour of the light off sunlit sand",
    label: "bounce colour",
  }),
  crownHeight: param.number({
    hint: "height: the top's swell over the plate, like a bun's",
    label: "crown height",
    max: 12,
    min: 0,
    step: 0.25,
    value: MAP.crownHeight,
  }),
  crownWidth: param.number({
    hint: "height: how far inland the crown rises most of the way",
    label: "crown width",
    max: 60,
    min: 1,
    step: 0.5,
    value: MAP.crownWidth,
  }),
  dataset: param.select(ISLANDS_DATASETS, "foundry", {
    hint: "Foundry's own workspace, through its adapter",
  }),
  // Coverage.
  feather: param.number({
    hint: "coverage: texels across the coast's ease",
    max: 8,
    min: 0.25,
    step: 0.25,
    value: MAP.feather,
  }),

  // Files.
  fileRadius: param.number({
    hint: "files: each file's disc on its island, chart units (the files view)",
    label: "file radius",
    max: 6,
    min: 0.5,
    step: 0.25,
    value: MAP.fileRadius,
  }),
  fileStrength: param.number({
    hint: "files: how strongly the files show on the shaded ground; 0 hides them (the town carries them)",
    label: "file strength",
    max: 1,
    min: 0,
    step: 0.05,
    value: 0,
  }),
  grass: param.number({
    hint: "the turf on the tops in place of the islands' caps, 0–1",
    label: "grass",
    max: 1,
    min: 0,
    step: 0.05,
    value: 1,
  }),
  grassDry: param.color("#a9b45a", {
    hint: "the turf's sunbleached green, at the edges and dry patches",
    label: "grass dry",
  }),
  grassLush: param.color("#4f8a2e", {
    hint: "the turf's deep green, in hollows and lush patches",
    label: "grass lush",
  }),
  grassSheen: param.number({
    hint: "the turf's pale glow toward a grazing eye",
    label: "grass sheen",
    max: 2,
    min: 0,
    step: 0.05,
    value: 0.6,
  }),
  gustSize: param.number({
    hint: "how long a gust runs along the wind, chart units",
    label: "gust size",
    max: 120,
    min: 4,
    step: 1,
    value: 34,
  }),
  highlight: param.number({
    hint: "selection: how much the chosen island or ring lightens",
    max: 1,
    min: 0,
    step: 0.02,
    value: 0.4,
  }),
  highlightColor: param.color("#fff3cf", {
    hint: "selection: the fill's and the outline's colour",
    label: "highlight colour",
  }),
  highlightDim: param.number({
    hint: "selection: how much the rest darkens while something is chosen",
    label: "highlight dim",
    max: 1,
    min: 0,
    step: 0.02,
    value: 0.3,
  }),
  highlightMembers: param.number({
    hint: "selection: how much a chosen ring's islands lighten, against its plates",
    label: "highlight members",
    max: 1,
    min: 0,
    step: 0.02,
    value: 0.5,
  }),
  highlightOutline: param.number({
    hint: "selection: the outline round the chosen and the hovered; 0 for none",
    label: "highlight outline",
    max: 1,
    min: 0,
    step: 0.02,
    value: 0.9,
  }),
  lipHeight: param.number({
    hint: "height: a thin raised band along the edge",
    label: "lip height",
    max: 4,
    min: 0,
    step: 0.1,
    value: MAP.lipHeight,
  }),
  lipWidth: param.number({
    label: "lip width",
    max: 10,
    min: 0,
    step: 0.25,
    value: MAP.lipWidth,
  }),
  occlusion: param.number({
    hint: "light: how deep the baked ambient occlusion sits in creases and at the feet of walls; 1 as baked",
    max: 4,
    min: 0,
    step: 0.05,
    value: 1.6,
  }),
  occlusionSun: param.number({
    hint: "light: the share of the ambient occlusion the sun takes too, so the ground stays grounded in full light; 0 fill only",
    label: "occlusion in sun",
    max: 1,
    min: 0,
    step: 0.05,
    value: 0.35,
  }),
  // Paint.
  palette: param.select(ISLANDS_PALETTES, MAP.palette, {
    hint: "paint: which pastel cap an island takes, by island order or by a hash of its id",
    label: "palette",
  }),
  // Height, chart units: the land (the sea's floor is the sea's).
  plateHeight: param.number({
    hint: "height: the land's flat top above sea level",
    label: "plate height",
    max: 40,
    min: 0.5,
    step: 0.5,
    value: MAP.plateHeight,
  }),

  // Frame.
  renderScale: param.number({
    hint: "the film's size against the canvas; the composite upsamples",
    label: "render scale",
    max: 1,
    min: 0.25,
    step: 0.05,
    value: 1,
  }),
  resolution: param.select(ISLANDS_RESOLUTIONS, `${MAP.resolution}`, {
    hint: "texels a side of every map",
  }),
  rimSmoothing: param.number({
    hint: "height: the rim follows the coast's course without its finest wiggles, chart units; 0 for none",
    label: "rim smoothing",
    max: 10,
    min: 0,
    step: 0.25,
    value: MAP.rimSmoothing,
  }),
  rimWidth: param.number({
    hint: "height: the rise from the coast to the plate",
    label: "rim width",
    max: 20,
    min: 0.25,
    step: 0.25,
    value: MAP.rimWidth,
  }),
  rockColor: param.color("#b08878", {
    hint: "the cliff rock on the land's steep rim",
    label: "rock colour",
  }),
  rockTint: param.number({
    hint: "how far the rock takes its island's hue, 0–1",
    label: "rock tint",
    max: 1,
    min: 0,
    step: 0.05,
    value: 0.35,
  }),
  seaFill: param.color("#6a8c9c", {
    hint: "light: the fill from below, off the sea, on undersides and lee faces",
    label: "sea fill",
  }),
  // Selection: click an island or a ring to choose it, Escape to let go.
  selection: param.toggle(true, {
    hint: "selection: click an island or a ring to choose it, hover to outline; off lets go and stops picking",
  }),
  shadowStrength: param.number({
    hint: "light: how much sun a cast shadow takes away; 1 all of it",
    label: "shadow strength",
    max: 1,
    min: 0,
    step: 0.05,
    value: 0.6,
  }),
  skyColor: param.color("#93b2da", {
    hint: "light: the fill from above under a low sun; it goes neutral toward noon",
    label: "sky colour",
  }),
  skyFill: param.number({
    hint: "light: the fill everywhere, shadows included",
    label: "sky fill",
    max: 1.5,
    min: 0,
    step: 0.02,
    value: 0.58,
  }),
  softLight: param.number({
    hint: "light: wraps the sun round gentle ground, so tops read smooth while cliffs keep their shadow side",
    label: "soft light",
    max: 1,
    min: 0,
    step: 0.05,
    value: 0.45,
  }),
  // Light.
  sunAzimuth: param.number({
    hint: "light: radians clockwise from north",
    label: "sun azimuth",
    max: TURN,
    min: 0,
    step: 0.01,
    value: MAP.sunAzimuth,
  }),
  sunElevation: param.number({
    hint: "light: radians above the horizon",
    label: "sun elevation",
    max: 1.5,
    min: 0.05,
    step: 0.01,
    value: MAP.sunElevation,
  }),
  sunStrength: param.number({
    hint: "light: the key, scaled so a flat sunlit face keeps its brightness at any elevation",
    label: "sun strength",
    max: 2,
    min: 0,
    step: 0.02,
    value: 0.78,
  }),
  sunWarmth: param.number({
    hint: "light: how golden a low sun is; 0 neutral white",
    label: "sun warmth",
    max: 1.5,
    min: 0,
    step: 0.05,
    value: 0.5,
  }),

  // Distance.
  tileWorldSize: param.number({
    hint: "World units per tile; 0 preserves chart-fitted maps",
    label: "bake tile span",
    max: 8192,
    min: 0,
    step: 128,
    value: MAP.tileWorldSize,
  }),
  view: param.select(ISLANDS_VIEWS, "shaded", {
    hint: "shaded: the paint lit, with water; or any one map draped over the terrain",
  }),
  vignette: param.number({
    hint: "the margins darken toward the vignette's warm sepia; 0 for none",
    max: 1,
    min: 0,
    step: 0.02,
    value: 0.36,
  }),
  vignetteColor: param.color("#c7b399", {
    hint: "the tint the margins darken toward",
    label: "vignette colour",
  }),
  wind: param.number({
    hint: "how hard the wind lays the turf over, blowing the swell's way, 0 for still",
    label: "wind",
    max: 2,
    min: 0,
    step: 0.05,
    value: 1,
  }),
  windSpeed: param.number({
    hint: "how fast the gusts run over the turf, chart units a second",
    label: "wind speed",
    max: 40,
    min: 0,
    step: 0.5,
    value: 9,
  }),

  // The sea: bathymetry, floor and flow are baked into the maps; surface
  // and shore are the frame's.
  ...seaSettings,
});

export type IslandsSettings = ParamValues<typeof islandsParams>;
