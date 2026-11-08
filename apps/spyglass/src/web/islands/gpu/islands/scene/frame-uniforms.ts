/**
 * The frame's uniforms out of a `Look` and a `View`, as the terrain, water,
 * props and post read them: the frame's side of map-uniforms.ts. Pure, and
 * free of `vgpu` values, so scene.ts only orchestrates.
 */

import { CLIP_CELLS, type ClipLayout, SUBTEXELS } from "../land/clipmap";
import type { DebrisLight } from "../land/debris";
import { VIEWED_MAPS } from "../maps/map-params";
import {
  frameUniform,
  type MapFrame,
  openFloorDepth,
  sideOf,
} from "../maps/map-uniforms";
import type { PostLook } from "../post/post";
import type { View } from "../view/camera";
import { floorColorOf, type Look } from "./look";

/** 0 for the shaded view, else 1 + the map's index among the viewed (terrain.wgsl `Grid.view`). */
const viewIndex = (view: Look["view"]): number =>
  view === "shaded" ? 0 : VIEWED_MAPS.indexOf(view) + 1;

/** The eye and its aperture, the rays a screen uv casts (water.wgsl `Eye`, pick.wgsl `Pick`). */
export const rayUniform = (view: View) => ({
  apertureX: view.aperture[0],
  apertureY: view.aperture[1],
  eye: view.eye,
  forward: view.forward,
  near: view.near,
  right: view.right,
  up: view.up,
});

/** The seabed map's square, as the frame's shaders place it: its corner and side. */
const seabedPlace = (seabed: MapFrame) => ({
  seabedOrigin: seabed.origin,
  seabedSide: sideOf(seabed),
});

/** The terrain's uniforms: both clipmap draws take the same. */
export function terrainUniforms(
  view: View,
  clip: ClipLayout,
  grid: MapFrame,
  seabed: MapFrame,
  look: Look
) {
  return {
    camera: {
      eye: view.eye,
      time: look.time,
      viewProjection: view.viewProjection,
    },
    clip: {
      cells: CLIP_CELLS,
      origin: [clip.origin[0] * SUBTEXELS, clip.origin[1] * SUBTEXELS],
      stride: clip.stride * SUBTEXELS,
    },
    grid: {
      ...frameUniform(grid),
      flowSpeed: look.flowSpeed,
      land: look.land,
      ramp: [look.distanceReach, look.floorDepth, look.landTop],
      view: viewIndex(look.view),
      ...seabedPlace(seabed),
      floor: look.floorPaint,
    },
    look: {
      bounce: look.bounce,
      bounceStrength: look.bounceStrength,
      files: look.files,
      grass: look.grass,
      grassDry: look.grassDry,
      grassLush: look.grassLush,
      grassSheen: look.grassSheen,
      gustSize: look.gustSize,
      occlusion: look.occlusion,
      occlusionSun: look.occlusionSun,
      rippleSpacing: look.rippleSpacing,
      ripples: look.ripples,
      rock: look.rock,
      rockTint: look.rockTint,
      seaFill: look.seaFill,
      shadowStrength: look.shadowStrength,
      skyColor: look.skyColor,
      skyStrength: look.skyStrength,
      softLight: look.softLight,
      speck: look.speck,
      speckDensity: look.speckDensity,
      speckSize: look.speckSize,
      specks: look.specks,
      sun: look.sun,
      sunColor: look.sunColor,
      sunStrength: look.sunStrength,
      top: look.top,
      wind: look.wind,
      windHeading: look.windHeading,
      windSpeed: look.windSpeed,
    },
  };
}

/** The water composite's uniforms. */
export function waterUniforms(
  view: View,
  grid: MapFrame,
  seabed: MapFrame,
  look: Look
) {
  return {
    eye: {
      viewProjection: view.viewProjection,
      ...rayUniform(view),
      time: look.time,
    },
    grid: { ...frameUniform(grid), ...seabedPlace(seabed) },
    highlight: {
      color: look.highlightColor,
      dim: look.highlightDim,
      fill: look.highlight,
      memberFill: look.highlightMembers,
      outline: look.highlightOutline,
    },
    water: {
      absorption: look.absorption,
      bands: look.bands,
      causticSize: look.causticSize,
      caustics: look.caustics,
      clarity: look.clarity,
      depthCurve: look.depthCurve,
      depthPower: look.depthPower,
      enabled: look.water ? 1 : 0,
      floorColor: floorColorOf(look),
      floorDepth: look.floorDepth,
      haze: look.haze,
      hazeFar: look.hazeFar,
      hazeNear: look.hazeNear,
      horizon: look.skyHorizon,
      legend: look.legend,
      openDepth: openFloorDepth(
        {
          descent: look.seascapeDescent,
          floorDepth: look.floorDepth,
          step: look.seascapeStep,
        },
        grid,
        seabed
      ),
      reflection: look.reflection,
      refraction: look.refraction,
      refractionReach: look.refractionReach,
      relief: look.relief,
      rim: look.rim,
      scatter: look.scatter,
      seaLine: look.seaLine,
      seaLines: look.seaLines,
      seascapeRelief: look.seascapeRelief,
      shadowAmbient: look.shadowAmbient,
      shoalGlow: look.shoalGlow,
      shoalReach: look.shoalReach,
      slopeWidth: look.slopeWidth,
      specular: look.specular,
      sun: look.sun,
      sunColor: look.sunColor,
      surf: look.surf,
      surfSpacing: look.surfSpacing,
      surfSpeed: look.surfSpeed,
      swash: look.swash,
      swashPeriod: look.swashPeriod,
      swashReach: look.swashReach,
      top: look.top,
      wash: look.wash,
      washPeriod: look.washPeriod,
      washWidth: look.washWidth,
      waveStrength: look.waveStrength,
      waves: look.waves,
      wetSand: look.wetSand,
      zenith: look.skyZenith,
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
    occlusion: look.occlusion,
    occlusionSun: look.occlusionSun,
    rings: look.water ? look.debrisRings : 0,
    rock: look.rock,
    seaFill: look.seaFill,
    shadowStrength: look.shadowStrength,
    skyColor: look.skyColor,
    skyStrength: look.skyStrength,
    sun: look.sun,
    sunColor: look.sunColor,
    sunStrength: look.sunStrength,
    time: look.time,
    viewProjection: view.viewProjection,
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
