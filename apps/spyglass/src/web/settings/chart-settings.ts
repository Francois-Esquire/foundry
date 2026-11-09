import {
  defaultValues,
  defineParams,
  type ParamGroupOf,
  type ParamValues,
  param,
} from "../islands/lab/params";
import {
  defaultSceneComposition,
  type SceneComposition,
} from "./scene-composition";

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

/** The named angle shown at an elevation, to the whole degree; none for an elevation between them. */
export function cameraAngleAt(elevation: number): CameraAngleId | undefined {
  return (Object.keys(cameraAngles) as CameraAngleId[]).find(
    (id) => Math.round(cameraAngles[id].elevation) === Math.round(elevation)
  );
}

/**
 * What a reader may change: the camera's elevation, which starts at the
 * chart's own angle, and the waves, decoration that is on until turned off
 * and stills under reduced motion. The map maps them onto Islands
 * (`islands-host/map-view.ts`): the elevation to the camera's pitch, the
 * waves to its `waveAmplitude`.
 */
export const readerParams = defineParams({
  /**
   * The camera's elevation above the horizon, in degrees. The camera never
   * lies lower than 30°, where the chart's north–south runs at half its
   * length; at 90° it looks straight down.
   */
  elevation: param.number({
    label: "Elevation",
    max: 90,
    min: 30,
    step: 1,
    unit: "°",
    value: cameraAngles.chart.elevation,
  }),
  waves: param.toggle(true, { label: "Water motion" }),
});

export const readerLayout: readonly ParamGroupOf<typeof readerParams>[] = [
  {
    hint: "The angle the chart is seen from. Straight down reads as a flat map; lower angles show the relief.",
    keys: ["elevation"],
    title: "Camera",
  },
  {
    hint: "Decoration that carries no data: the sea's waves. They stand still when the system asks for reduced motion.",
    keys: ["waves"],
    title: "Atmosphere",
  },
];

export type ReaderSettings = ParamValues<typeof readerParams>;

/** A developer session's controls: which of the chart's details and its chrome show (`sceneLayerParams`). */
interface DeveloperSettings {
  composition: SceneComposition;
}

export type ChartSettings = ReaderSettings & DeveloperSettings;

export const defaultChartSettings: ChartSettings = {
  ...defaultValues(readerParams),
  composition: defaultSceneComposition,
};
