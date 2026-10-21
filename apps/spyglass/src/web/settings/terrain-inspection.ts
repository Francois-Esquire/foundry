/**
 * What the terrain's inspection shows in place of the water, one field at a
 * time. The structural fields replace the sea's water; the geology fields
 * are the world terrain's and show on the geology preview, so the sea keeps
 * its water while one of them is chosen.
 */
export const terrainInspections = [
  { id: "", label: "Ocean reading" },
  { id: "elevation", label: "Elevation" },
  { id: "water-depth", label: "Water depth · dark is deep" },
  { id: "signed-distance", label: "Signed distance to coast" },
  { id: "shelf", label: "Shared shelf thickness" },
  { id: "basement", label: "Internal basement thickness" },
  { id: "slope", label: "Slope and cliff faces" },
  { id: "land", label: "Land reading" },
  { id: "world-elevation", label: "Geology · world elevation" },
  { id: "depth-band", label: "Geology · depth band · dark is deep" },
  { id: "landform", label: "Geology · landform archetype" },
  { id: "seafloor", label: "Geology · seabed feature influence" },
] as const;

export type TerrainInspection = (typeof terrainInspections)[number]["id"];

/** The inspections of the world terrain, which the geology preview shows. */
const geologyInspections = [
  "world-elevation",
  "depth-band",
  "landform",
  "seafloor",
] as const satisfies readonly TerrainInspection[];

export type GeologyInspection = (typeof geologyInspections)[number];

export function isTerrainInspection(id: string): id is TerrainInspection {
  return terrainInspections.some((inspection) => inspection.id === id);
}

export function isGeologyInspection(id: string): id is GeologyInspection {
  return (geologyInspections as readonly string[]).includes(id);
}
