import {
  defaultValues,
  defineParams,
  type ParamGroupOf,
  type ParamValues,
  param,
} from "../islands/lab/params";

/**
 * What the viewer lays over the map, one vocabulary across the map and the
 * UI: the DOM labels and the chart's chrome. Islands draws everything under
 * them; these say which of the viewer's own layers show, one toggle a
 * layer, on when it shows. The detail toggles' layers start off.
 */
export const sceneLayerParams = defineParams({
  "chart-frame": param.toggle(true, { label: "Chart frame" }),
  coordinates: param.toggle(false, { label: "Coordinates" }),
  labels: param.toggle(false, { label: "Map labels" }),
  "latitude-scale": param.toggle(false, { label: "Latitude scale" }),
  "sea-caption": param.toggle(false, { label: "Sea caption" }),
});

export const sceneLayout: readonly ParamGroupOf<typeof sceneLayerParams>[] = [
  {
    hint: "What the viewer letters over the canvas. The app bar's buttons turn them on in groups.",
    keys: [
      "labels",
      "chart-frame",
      "coordinates",
      "latitude-scale",
      "sea-caption",
    ],
    title: "Annotations",
  },
];

export type SceneLayerId = keyof typeof sceneLayerParams;

export type SceneComposition = ParamValues<typeof sceneLayerParams>;

/** Detail the app bar toggles in, one button a group; each starts hidden. */
export const detailToggles = [
  { id: "labels", label: "Labels", layers: ["labels", "sea-caption"] },
  { id: "ruler", label: "Ruler", layers: ["coordinates", "latitude-scale"] },
] as const satisfies readonly {
  id: string;
  label: string;
  layers: readonly SceneLayerId[];
}[];

export const defaultSceneComposition: SceneComposition =
  defaultValues(sceneLayerParams);

/** Composition gates what the viewer lays over the map; data and zoom gates still apply. */
export function isSceneLayerVisible(
  composition: SceneComposition,
  id: SceneLayerId
): boolean {
  return composition[id];
}
