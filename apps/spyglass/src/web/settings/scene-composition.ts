/** Drawable layers share one vocabulary across the scene, DOM, and interaction. */
export const sceneLayerDefinitions = [
  { category: "World", id: "sea", label: "Ocean" },
  { category: "World", id: "relief", label: "Island surfaces" },
  { category: "World", id: "cliffs", label: "Coastal cliffs" },
  { category: "World", id: "ground", label: "Connecting land" },
  { category: "World", id: "roads", label: "Roads" },
  { category: "World", id: "trades", label: "Trade routes" },
  { category: "World", id: "wrecks", label: "Former packages" },
  { category: "Marks", id: "chart-grid", label: "Chart grid" },
  { category: "Marks", id: "sea-ripples", label: "Sea ripples" },
  { category: "Marks", id: "coast", label: "Coast outlines" },
  { category: "Marks", id: "belonging", label: "Belonging" },
  { category: "Marks", id: "folders", label: "Folders" },
  { category: "Marks", id: "domain", label: "Domain" },
  { category: "Marks", id: "connections", label: "File connections" },
  { category: "Marks", id: "files", label: "Files" },
  { category: "Marks", id: "file-members", label: "Group members" },
  { category: "Marks", id: "responsibility", label: "Responsibility" },
  { category: "Marks", id: "proximity", label: "Proximity" },
  { category: "Marks", id: "file-focus", label: "File focus" },
  { category: "Marks", id: "topography", label: "Contours" },
  { category: "Marks", id: "crossings", label: "Package crossings" },
  { category: "Marks", id: "departures", label: "Departures" },
  { category: "Marks", id: "domain-departures", label: "Domain departures" },
  { category: "Marks", id: "selection", label: "Selection" },
  { category: "Marks", id: "boundaries", label: "Region boundaries" },
  { category: "Marks", id: "hover", label: "Hover marks" },
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

export const defaultSceneComposition: SceneComposition = {
  hidden: [],
  solo: [],
};

export const sceneCompositionPresets: readonly {
  id: string;
  label: string;
  layers: readonly SceneLayerId[];
}[] = [
  { id: "ocean", label: "Ocean", layers: ["sea"] },
  {
    id: "terrain",
    label: "Terrain",
    layers: ["sea", "relief", "cliffs", "ground"],
  },
  {
    id: "annotated-map",
    label: "Annotated map",
    layers: sceneLayerDefinitions.map(({ id }) => id),
  },
];

export function isSceneLayerId(id: string): id is SceneLayerId {
  return sceneLayerDefinitions.some((layer) => layer.id === id);
}

/** Composition gates rendering; existing data, zoom, and reader gates still apply. */
export function isSceneLayerVisible(
  composition: SceneComposition,
  id: SceneLayerId
): boolean {
  return composition.solo.length > 0
    ? composition.solo.includes(id)
    : !composition.hidden.includes(id);
}
