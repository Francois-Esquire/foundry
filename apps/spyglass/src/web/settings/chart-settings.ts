import { defaultSceneComposition } from "./scene-composition";

/** Rendering tiers, as the developer readout names them; Islands always draws at "high". */
const renderQualities = {
  high: { label: "Full" },
  low: { label: "Light" },
  medium: { label: "Balanced" },
  off: { label: "Off · direct draw" },
};

export type RenderQuality = keyof typeof renderQualities;

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
 * What a reader may change: the waves, decoration that is on until turned
 * off and stills under reduced motion, and the camera's angle, which starts
 * at the chart's own.
 */
export const defaultReaderSettings = {
  /** The camera's elevation above the horizon, in degrees. */
  camera: { elevation: cameraAngles.chart.elevation },
  /** The sea's waves (Islands' `waveAmplitude`). Retains the legacy waves key. */
  waves: true,
};

export type ReaderSettings = typeof defaultReaderSettings;

/** A developer session's controls: which of the chart's details and its chrome show. */
export const defaultDeveloperSettings = {
  composition: defaultSceneComposition,
};

type DeveloperSettings = typeof defaultDeveloperSettings;

export type ChartSettings = ReaderSettings & DeveloperSettings;

export const defaultChartSettings: ChartSettings = {
  ...defaultReaderSettings,
  ...defaultDeveloperSettings,
};
