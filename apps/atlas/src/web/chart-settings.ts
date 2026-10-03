import { defaultLandmassSettings } from "./landmasses";
import { defaultBoundaries } from "./scene/boundaries";

export const chartFilters = {
  faded: { filter: "saturate(0.45) sepia(0.18)", label: "Faded pigments" },
  graphite: { filter: "grayscale(1)", label: "Graphite" },
  original: { filter: "none", label: "Original" },
  treasure: {
    filter: "grayscale(1) sepia(0.65) saturate(0.85)",
    label: "Treasure parchment",
  },
};

/** Post-processing tiers. "off" draws the scene directly, as the atlas always has. */
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

/** Intermediate pipeline stages the panel can show in place of the final image. */
export const renderStages = {
  bloom: { label: "Bloom only" },
  depth: { label: "Depth" },
  final: { label: "Final image" },
  indirect: { label: "Indirect light" },
  occlusion: { label: "Occlusion" },
};

export type RenderStage = keyof typeof renderStages;

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

export const defaultChartSettings = {
  ...defaultLandmassSettings,
  boundaries: defaultBoundaries,
  contours: false,
  currentSpeed: 1,
  dependencyInfluence: 1,
  filter: "original" as keyof typeof chartFilters,
  layers: {
    forests: false,
    houses: false,
    land: false,
    roads: false,
    trade: false,
  },
  rendering: defaultRenderSettings,
  /** District streams: imports between responsibilities drawn on the land. */
  streams: false,
  volcanic: false,
  waterColor: "#d5dbca",
  waterContrast: 0.3,
  waveAmount: 0.45,
  wavelength: 36,
  waveStrength: 0.45,
  windDirection: 45,
  windInfluence: 0.3,
  windStrength: 0.5,
};

export type ChartSettings = typeof defaultChartSettings;
