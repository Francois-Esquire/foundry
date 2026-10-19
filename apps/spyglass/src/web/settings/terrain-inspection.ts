/** What the terrain's inspection shows in place of the water, one structural field at a time. */
export const terrainInspections = [
  { id: "", label: "Ocean reading" },
  { id: "elevation", label: "Elevation" },
  { id: "water-depth", label: "Water depth · dark is deep" },
  { id: "signed-distance", label: "Signed distance to coast" },
  { id: "shelf", label: "Shared shelf thickness" },
  { id: "basement", label: "Internal basement thickness" },
  { id: "slope", label: "Slope and cliff faces" },
  { id: "land", label: "Land reading" },
] as const;

export type TerrainInspection = (typeof terrainInspections)[number]["id"];

export function isTerrainInspection(id: string): id is TerrainInspection {
  return terrainInspections.some((inspection) => inspection.id === id);
}
