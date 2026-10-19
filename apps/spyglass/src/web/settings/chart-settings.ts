import { defaultBoundaries } from "./boundary-settings";
import { defaultLandmassSettings } from "./landmass-settings";
import { defaultSceneComposition } from "./scene-composition";
import type { TerrainInspection } from "./terrain-inspection";

/** Post-processing tiers. "off" draws the scene directly, as the spyglass always has. */
export const renderQualities = {
  high: { label: "Full" },
  low: { label: "Light" },
  medium: { label: "Balanced" },
  off: { label: "Off · direct draw" },
};

export type RenderQuality = keyof typeof renderQualities;

export const toneMappings = {
  aces: { label: "ACES filmic" },
  agx: { label: "AgX" },
  neutral: { label: "Neutral" },
  none: { label: "None (linear)" },
  reinhard: { label: "Reinhard" },
};

export type ToneMappingId = keyof typeof toneMappings;

/**
 * The views the rendering sheet may show in place of the finished image: a
 * stage of the pass graph by its id (`scene/stages/`, which lists them with
 * their labels as `renderStages`), or the depth.
 */
export type RenderStage =
  | "bloom"
  | "depth"
  | "final"
  | "indirect"
  | "occlusion"
  | "outline";

/**
 * Rendering pipeline controls. Defaults keep the chart's matte paper look:
 * linear output at unit exposure and engraved relief shading, with a bloom
 * gated above every ink on the chart so that only the selection's glow lifts.
 */
export const defaultRenderSettings = {
  ambientOcclusion: true,
  aoIntensity: 1,
  /** Occlusion reach in screen pixels, so the look holds at every zoom. */
  aoReach: 10,
  bloom: true,
  bloomRadius: 0.35,
  bloomStrength: 0.6,
  bloomThreshold: 0.85,
  exposure: 1,
  giIntensity: 1,
  globalIllumination: false,
  quality: "medium" as RenderQuality,
  saturation: 1,
  /** Light along the selected island's coast, which the bloom lifts. */
  selectionGlow: true,
  stage: "final" as RenderStage,
  toneMapping: "none" as ToneMappingId,
  vibrance: 0,
};

export type RenderSettings = typeof defaultRenderSettings;

/**
 * The named camera angles, each an elevation above the horizon in degrees:
 * 90 looks straight down. The chart's own angle is 0.7 radians off the
 * vertical, the angle the chart has always been read at.
 */
export const cameraAngles = {
  chart: { elevation: 90 - (0.7 * 180) / Math.PI, label: "Chart (50°)" },
  isometric: { elevation: 55, label: "Isometric (55°)" },
  "top-down": { elevation: 90, label: "Top-down (90°)" },
};

export type CameraAngleId = keyof typeof cameraAngles;

/**
 * The elevations a reader may set, in degrees. The camera never lies lower
 * than 30° above the horizon, where the chart's north–south runs at half its
 * length; at 90° it looks straight down.
 */
export const cameraElevationRange = { max: 90, min: 30 };

/** The named angle shown at an elevation, to the whole degree; none for an elevation between them. */
export function cameraAngleAt(elevation: number): CameraAngleId | undefined {
  return (Object.keys(cameraAngles) as CameraAngleId[]).find(
    (id) => Math.round(cameraAngles[id].elevation) === Math.round(elevation)
  );
}

/**
 * What a reader may change: the layers that carry data, off until asked for,
 * the weather, decoration that is on until turned off and stills under
 * reduced motion, and the camera's angle, which starts at the chart's own.
 */
export const defaultReaderSettings = {
  /** The camera's elevation above the horizon, in degrees. The light stays fixed in the world. */
  camera: { elevation: cameraAngles.chart.elevation },
  /** Foundation light: preserved moving light over fixed underwater shelves. Retains the legacy clouds key. */
  clouds: true,
  /** Topographic lines: contours of the high fan-in summits. */
  contours: false,
  /** District streams: imports between responsibilities drawn on the land. */
  streams: false,
  /** Sea trade routes: each package's leading consumers. */
  trade: false,
  /** Recorded change: frequently changed files, with their counts in Place. */
  volcanic: false,
  /** Rim surf: breaks along each archipelago's rim. Retains the legacy waves key. */
  waves: true,
};

export type ReaderSettings = typeof defaultReaderSettings;

/**
 * A developer session's controls: the layout's tuning and outlines, the two
 * layers that draw package dependency again (connecting land and roads,
 * which rebuild the scene), and the renderer.
 */
export const defaultDeveloperSettings = {
  ...defaultLandmassSettings,
  boundaries: defaultBoundaries,
  composition: defaultSceneComposition,
  foundationFocus: "",
  layers: { land: false, roads: false },
  rendering: defaultRenderSettings,
  /** One structural field shown in place of the water; empty for the ocean reading. */
  terrainInspection: "" as TerrainInspection,
};

export type DeveloperSettings = typeof defaultDeveloperSettings;

export type ChartSettings = ReaderSettings & DeveloperSettings;

export const defaultChartSettings: ChartSettings = {
  ...defaultReaderSettings,
  ...defaultDeveloperSettings,
};
