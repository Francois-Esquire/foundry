/** Layers and material effects share one vocabulary across the scene and UI. */
export const sceneLayerDefinitions = [
  { category: "World", id: "sea", label: "Ocean" },
  { category: "World", id: "relief", label: "Island surfaces" },
  { category: "World", id: "cliffs", label: "Coastal cliffs" },
  { category: "World", id: "ground", label: "Connecting land" },
  { category: "World", id: "roads", label: "Roads" },
  { category: "World", id: "trades", label: "Trade routes" },
  { category: "World", id: "wrecks", label: "Former packages" },
  { category: "World", id: "geology", label: "Geology preview" },
  { category: "Effects", id: "ocean-depth", label: "Depth shading" },
  { category: "Effects", id: "ocean-shallows", label: "Shallows" },
  {
    category: "Effects",
    id: "dependency-foundations",
    label: "Dependency foundations",
  },
  { category: "Effects", id: "subsurface-drift", label: "Foundation light" },
  { category: "Effects", id: "rim-surf", label: "Rim surf" },
  { category: "Effects", id: "surface-motion", label: "Surface motion" },
  { category: "Marks", id: "chart-grid", label: "Chart grid" },
  { category: "Marks", id: "sea-ripples", label: "Sea ripples" },
  { category: "Marks", id: "coast", label: "Coast outlines" },
  { category: "Marks", id: "belonging", label: "Belonging" },
  { category: "Marks", id: "folders", label: "Folders" },
  { category: "Marks", id: "domain", label: "Domain" },
  { category: "Marks", id: "connections", label: "File connections" },
  { category: "Marks", id: "dependency-routes", label: "Dependency routes" },
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

/** Detail the app bar toggles in, one button a group; each starts hidden. */
export const detailToggles = [
  {
    id: "routes",
    label: "Routes",
    layers: [
      "dependency-routes",
      "crossings",
      "departures",
      "domain-departures",
    ],
  },
  { id: "labels", label: "Labels", layers: ["labels", "sea-caption"] },
  {
    id: "details",
    label: "Details",
    // Everything drawn inside an island; its coast and the selection stay.
    layers: [
      "belonging",
      "folders",
      "domain",
      "connections",
      "files",
      "file-members",
      "responsibility",
      "proximity",
      "file-focus",
      "topography",
    ],
  },
  { id: "ruler", label: "Ruler", layers: ["coordinates", "latitude-scale"] },
] as const satisfies readonly {
  id: string;
  label: string;
  layers: readonly SceneLayerId[];
}[];

/**
 * Every detail toggle's layers start hidden, and so does the geology
 * preview: it is a developer's view of the world terrain, reached through
 * its preset, never through the app bar.
 */
export const defaultSceneComposition: SceneComposition = {
  hidden: [...detailToggles.flatMap(({ layers }) => layers), "geology"],
  solo: [],
};

const oceanEffects = sceneLayerDefinitions
  .filter(({ category }) => category === "Effects")
  .map(({ id }) => id);

export const sceneCompositionPresets: readonly {
  id: string;
  label: string;
  layers: readonly SceneLayerId[];
}[] = [
  { id: "ocean", label: "Ocean", layers: ["sea", ...oceanEffects] },
  { id: "clean-ocean", label: "Clean ocean", layers: ["sea"] },
  {
    id: "terrain",
    label: "Terrain only",
    layers: ["sea", "relief", "cliffs", ...oceanEffects],
  },
  {
    id: "annotated-map",
    label: "Annotated map",
    // The geology preview replaces the sea and the islands; it is not an annotation.
    layers: sceneLayerDefinitions
      .map(({ id }) => id)
      .filter((id) => id !== "geology"),
  },
  {
    id: "geology",
    label: "Geology preview",
    layers: ["geology", "surface-motion", "chart-frame"],
  },
];

/** Material effects need a visible surface; soloing one includes the ocean. */
export function sceneLayerSolo(id: SceneLayerId): readonly SceneLayerId[] {
  if (id === "subsurface-drift") {
    return ["sea", "dependency-foundations", id];
  }
  return sceneLayerDefinitions.some(
    (layer) => layer.id === id && layer.category === "Effects"
  )
    ? ["sea", id]
    : [id];
}

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
