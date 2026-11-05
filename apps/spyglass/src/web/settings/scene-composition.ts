/**
 * What the viewer lays over the map, one vocabulary across the map and the
 * UI: the DOM labels and the chart's chrome. Islands draws everything under
 * them; these say which of the viewer's own layers show.
 */
const sceneLayerDefinitions = [
  { category: "Annotations", id: "labels", label: "Map labels" },
  { category: "Annotations", id: "chart-frame", label: "Chart frame" },
  { category: "Annotations", id: "coordinates", label: "Coordinates" },
  { category: "Annotations", id: "latitude-scale", label: "Latitude scale" },
  { category: "Annotations", id: "sea-caption", label: "Sea caption" },
] as const;

export type SceneLayerId = (typeof sceneLayerDefinitions)[number]["id"];

export interface SceneComposition {
  hidden: readonly SceneLayerId[];
  /** A temporary isolation; clearing it restores the hidden-layer choices. */
  solo: readonly SceneLayerId[];
}

/** Detail the app bar toggles in, one button a group; each starts hidden. */
export const detailToggles = [
  { id: "labels", label: "Labels", layers: ["labels", "sea-caption"] },
  { id: "ruler", label: "Ruler", layers: ["coordinates", "latitude-scale"] },
] as const satisfies readonly {
  id: string;
  label: string;
  layers: readonly SceneLayerId[];
}[];

/** Every detail toggle's layers start hidden. */
export const defaultSceneComposition: SceneComposition = {
  hidden: detailToggles.flatMap(({ layers }) => layers),
  solo: [],
};

/** Composition gates what the viewer lays over the map; data and zoom gates still apply. */
export function isSceneLayerVisible(
  composition: SceneComposition,
  id: SceneLayerId
): boolean {
  return composition.solo.length > 0
    ? composition.solo.includes(id)
    : !composition.hidden.includes(id);
}
