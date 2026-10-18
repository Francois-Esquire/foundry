import { defaultBoundaries } from "./boundary-settings";
import { defaultLandmassSettings } from "./landmass-settings";

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
  | "occlusion";

/**
 * Rendering pipeline controls. Defaults keep the chart's matte paper look:
 * linear output at unit exposure and engraved relief shading without bloom.
 */
export const defaultRenderSettings = {
  ambientOcclusion: true,
  aoIntensity: 1,
  /** Occlusion reach in screen pixels, so the look holds at every zoom. */
  aoReach: 10,
  bloom: false,
  bloomRadius: 0.35,
  bloomStrength: 0.2,
  bloomThreshold: 0.8,
  exposure: 1,
  giIntensity: 1,
  globalIllumination: false,
  quality: "medium" as RenderQuality,
  saturation: 1,
  stage: "final" as RenderStage,
  toneMapping: "none" as ToneMappingId,
  vibrance: 0,
};

export type RenderSettings = typeof defaultRenderSettings;

/** What a reader may change: only layers that carry data. */
export const defaultReaderSettings = {
  /** Topographic lines: contours of the high fan-in summits. */
  contours: false,
  /** District streams: imports between responsibilities drawn on the land. */
  streams: false,
  /** Sea trade routes: each package's leading consumers. */
  trade: false,
  /** Recorded change: frequently changed files, with their counts in Place. */
  volcanic: false,
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
  layers: { land: false, roads: false },
  rendering: defaultRenderSettings,
};

export type DeveloperSettings = typeof defaultDeveloperSettings;

export type ChartSettings = ReaderSettings & DeveloperSettings;

export const defaultChartSettings: ChartSettings = {
  ...defaultReaderSettings,
  ...defaultDeveloperSettings,
};
