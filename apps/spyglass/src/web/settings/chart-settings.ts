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

const renderQualities = {
  high: { label: "Full" },
  low: { label: "Light" },
  medium: { label: "Balanced" },
  off: { label: "Off · direct draw" },
};

export type RenderQuality = keyof typeof renderQualities;

export const cameraAngles = {
  chart: { elevation: 90 - (0.7 * 180) / Math.PI, label: "Chart (50°)" },
  isometric: { elevation: 55, label: "Isometric (55°)" },
  "top-down": { elevation: 90, label: "Top-down (90°)" },
};

export type CameraAngleId = keyof typeof cameraAngles;

export function cameraAngleAt(elevation: number): CameraAngleId | undefined {
  return (Object.keys(cameraAngles) as CameraAngleId[]).find(
    (id) => Math.round(cameraAngles[id].elevation) === Math.round(elevation)
  );
}

export const readerParams = defineParams({
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

interface DeveloperSettings {
  composition: SceneComposition;
}

export type ChartSettings = ReaderSettings & DeveloperSettings;

export const defaultChartSettings: ChartSettings = {
  ...defaultValues(readerParams),
  composition: defaultSceneComposition,
};
